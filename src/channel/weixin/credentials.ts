/**
 * Weixin credential store.
 *
 * Storage layout (per profile, deliberately outside `config.json` — the bot
 * token is a secret and must never be written to the profile config or logged):
 *
 *   <profileDir>/weixin/index.json              → { version: 1, accounts: string[] }
 *   <profileDir>/weixin/accounts/<safeId>.json  → WeixinAccount (mode 0600)
 *
 * `safeId` rewrites every character outside `[A-Za-z0-9._-]` to `-`, so an
 * account id such as `4f0d…@im.bot` becomes `4f0d…-im.bot` on disk while the
 * in-file / in-config id stays verbatim.
 *
 * This file is bridge-native (not vendored): the layout is this repo's own
 * profile-state convention, not the upstream plugin's `~/.openclaw` layout.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '../../platform/atomic-write';
import { DEFAULT_WEIXIN_BASE_URL } from './protocol/api';

/** One logged-in WeChat bot account for a profile. */
export interface WeixinAccount {
  /** `ilink_bot_id` issued at login, e.g. `4f0d…@im.bot`. */
  id: string;
  /** Bot token for the iLink API. Secret: file mode 0600, never logged. */
  token: string;
  /** API base URL issued at login. */
  baseUrl: string;
  /** `ilink_user_id` of the person who scanned the login QR. */
  userId?: string;
  /** Optional display name. */
  name?: string;
  /** ISO timestamp of the successful login. */
  loggedInAt: string;
}

/** Shape written to `<profileDir>/weixin/index.json`. */
interface WeixinAccountIndex {
  version: 1;
  accounts: string[];
}

const INDEX_FILE = 'index.json';
const ACCOUNTS_DIR = 'accounts';
const ACCOUNT_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/** `<profileDir>/weixin`. */
export function weixinStateDir(profileDir: string): string {
  return join(profileDir, 'weixin');
}

/** `<profileDir>/weixin/accounts`. */
export function weixinAccountsDir(profileDir: string): string {
  return join(weixinStateDir(profileDir), ACCOUNTS_DIR);
}

/** Filesystem-safe form of an account id. Throws for an empty id. */
export function safeWeixinAccountId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error('weixin: account id must not be empty');
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Absolute path of an account credential file. */
export function weixinAccountPath(profileDir: string, id: string): string {
  return join(weixinAccountsDir(profileDir), `${safeWeixinAccountId(id)}.json`);
}

function validateAccount(account: WeixinAccount): WeixinAccount {
  const id = typeof account.id === 'string' ? account.id.trim() : '';
  const token = typeof account.token === 'string' ? account.token.trim() : '';
  if (!id) throw new Error('weixin: account id is required');
  if (!token) throw new Error(`weixin: account ${id} has no token`);
  const baseUrl = account.baseUrl?.trim() || DEFAULT_WEIXIN_BASE_URL;
  const userId = account.userId?.trim() || undefined;
  const name = account.name?.trim() || undefined;
  const loggedInAt = account.loggedInAt?.trim() || new Date().toISOString();
  return {
    id,
    token,
    baseUrl,
    ...(userId ? { userId } : {}),
    ...(name ? { name } : {}),
    loggedInAt,
  };
}

function parseAccount(raw: unknown): WeixinAccount | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!id || !token) return undefined;
  const baseUrl =
    typeof record.baseUrl === 'string' && record.baseUrl.trim()
      ? record.baseUrl.trim()
      : DEFAULT_WEIXIN_BASE_URL;
  const userId =
    typeof record.userId === 'string' && record.userId.trim() ? record.userId.trim() : undefined;
  const name =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
  const loggedInAt =
    typeof record.loggedInAt === 'string' && record.loggedInAt.trim()
      ? record.loggedInAt.trim()
      : new Date(0).toISOString();
  return {
    id,
    token,
    baseUrl,
    ...(userId ? { userId } : {}),
    ...(name ? { name } : {}),
    loggedInAt,
  };
}

function parseIndex(raw: string): WeixinAccountIndex {
  const parsed = JSON.parse(raw) as unknown;
  // Tolerate the upstream plugin's plain-string-array index as a legacy shape.
  if (Array.isArray(parsed)) {
    return {
      version: 1,
      accounts: parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
    };
  }
  if (parsed && typeof parsed === 'object') {
    const accounts = (parsed as { accounts?: unknown }).accounts;
    if (Array.isArray(accounts)) {
      return {
        version: 1,
        accounts: accounts.filter(
          (id): id is string => typeof id === 'string' && id.trim() !== '',
        ),
      };
    }
  }
  return { version: 1, accounts: [] };
}

async function readIndex(profileDir: string): Promise<WeixinAccountIndex> {
  try {
    return parseIndex(await readFile(join(weixinStateDir(profileDir), INDEX_FILE), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] };
    // A corrupt index must not lock the user out of their existing accounts.
    return { version: 1, accounts: [] };
  }
}

async function writeIndex(profileDir: string, index: WeixinAccountIndex): Promise<void> {
  const stateDir = weixinStateDir(profileDir);
  await mkdir(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  await writeFileAtomic(join(stateDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, {
    mode: ACCOUNT_FILE_MODE,
  });
}

/** Persist one account (creating the state dirs) and register it in the index. */
export async function saveWeixinAccount(
  profileDir: string,
  account: WeixinAccount,
): Promise<WeixinAccount> {
  const normalized = validateAccount(account);
  const filePath = weixinAccountPath(profileDir, normalized.id);
  await mkdir(dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
  await writeFileAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: ACCOUNT_FILE_MODE,
  });

  const index = await readIndex(profileDir);
  if (!index.accounts.includes(normalized.id)) {
    index.accounts.push(normalized.id);
    await writeIndex(profileDir, index);
  }
  return normalized;
}

/** Load one account by id; `undefined` when it was never logged in. */
export async function loadWeixinAccount(
  profileDir: string,
  id: string,
): Promise<WeixinAccount | undefined> {
  const filePath = weixinAccountPath(profileDir, id);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`weixin: corrupt credential file for account ${id}`);
  }
  const account = parseAccount(parsed);
  if (!account) throw new Error(`weixin: credential file for account ${id} is incomplete`);
  return account;
}

/**
 * Load every indexed account that still has a readable credential file.
 * Index order is preserved (oldest login first, matching upstream).
 */
export async function listWeixinAccounts(profileDir: string): Promise<WeixinAccount[]> {
  const index = await readIndex(profileDir);
  const accounts: WeixinAccount[] = [];
  for (const id of index.accounts) {
    try {
      const account = await loadWeixinAccount(profileDir, id);
      if (account) accounts.push(account);
    } catch {
      // Skip corrupt / half-written entries instead of failing the whole list.
    }
  }
  return accounts;
}

/** Delete one account's credentials and drop it from the index (idempotent). */
export async function clearWeixinAccount(profileDir: string, id: string): Promise<void> {
  const filePath = weixinAccountPath(profileDir, id);
  await rm(filePath, { force: true });

  const index = await readIndex(profileDir);
  const remaining = index.accounts.filter((entry) => entry !== id.trim());
  if (remaining.length !== index.accounts.length) {
    await writeIndex(profileDir, { version: 1, accounts: remaining });
  }
}

/** True when the credential file for `id` exists (used by status commands). */
export async function hasWeixinAccount(profileDir: string, id: string): Promise<boolean> {
  try {
    const info = await stat(weixinAccountPath(profileDir, id));
    return info.isFile();
  } catch {
    return false;
  }
}
