/**
 * Persisted inbound cursor + dedupe ring for one Weixin account.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT) for the
 * idea of persisting `get_updates_buf` (upstream `storage/sync-buf.ts`); the
 * layout and the message-id ring are bridge-native.
 *
 * File: `<profileDir>/weixin/<safeId>.sync.json` (mode 0600), where `safeId`
 * is the account id sanitised by the credential store. Shape:
 *
 *   {
 *     "buf": "<get_updates_buf from the last successful poll>",
 *     "seenMessageIds": ["…", "…"],   // oldest first, at most 500 entries
 *     "updatedAt": 1730000000000
 *   }
 *
 * The cursor is what makes the long-poll resume where it stopped; the ring is
 * a defensive second line of dedupe (server replays across restarts).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../../platform/atomic-write';
import { safeWeixinAccountId, weixinStateDir } from './credentials';

/** Maximum number of remembered message ids (ring buffer size). */
export const WEIXIN_SYNC_SEEN_LIMIT = 500;

/** Same file mode as credentials: this file must not be world-readable. */
const SYNC_FILE_MODE = 0o600;

/** Persisted transport state for one account. */
export interface WeixinSyncState {
  /** Latest `get_updates_buf`; empty string means "start from scratch". */
  buf: string;
  /** Recently processed message ids, oldest first (≤ {@link WEIXIN_SYNC_SEEN_LIMIT}). */
  seenMessageIds: string[];
  /** Epoch ms of the last successful save. */
  updatedAt: number;
}

/** Path of the sync state file for one account. */
export function weixinSyncPath(profileDir: string, accountId: string): string {
  return join(weixinStateDir(profileDir), `${safeWeixinAccountId(accountId)}.sync.json`);
}

function normalizeSyncState(raw: unknown): WeixinSyncState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const rawBuf = record.buf ?? record.get_updates_buf;
  if (typeof rawBuf !== 'string') return undefined;
  const rawSeen = record.seenMessageIds ?? record.seen_message_ids;
  const seenMessageIds = Array.isArray(rawSeen)
    ? rawSeen
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        .map((id) => id.trim())
    : [];
  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0;
  return { buf: rawBuf, seenMessageIds, updatedAt };
}

/**
 * Load the persisted state, or `undefined` when absent/corrupt.
 *
 * A corrupt cursor must never prevent the transport from starting: the worst
 * case is replaying a window of messages, which the dedupe ring and the
 * downstream handler tolerate.
 */
export async function loadWeixinSync(
  profileDir: string,
  accountId: string,
): Promise<WeixinSyncState | undefined> {
  try {
    const raw = await readFile(weixinSyncPath(profileDir, accountId), 'utf8');
    return normalizeSyncState(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Persist `buf` + the dedupe ring atomically (0600).
 *
 * The ring is deduped and trimmed to {@link WEIXIN_SYNC_SEEN_LIMIT} entries
 * here so callers can just append.
 */
export async function saveWeixinSync(
  profileDir: string,
  accountId: string,
  state: { buf: string; seenMessageIds: readonly string[]; updatedAt?: number },
): Promise<WeixinSyncState> {
  const deduped = [...new Set(state.seenMessageIds.filter((id) => id.trim() !== ''))];
  const normalized: WeixinSyncState = {
    buf: state.buf,
    seenMessageIds: deduped.slice(-WEIXIN_SYNC_SEEN_LIMIT),
    updatedAt: state.updatedAt ?? Date.now(),
  };
  await writeFileAtomic(
    weixinSyncPath(profileDir, accountId),
    `${JSON.stringify(normalized, null, 2)}\n`,
    { mode: SYNC_FILE_MODE },
  );
  return normalized;
}

/**
 * Append one message id to a bounded ring (mutates `seen`), returning it.
 * Consecutive duplicates are ignored; older entries fall off the front.
 */
export function rememberWeixinMessageId(
  seen: string[],
  messageId: string,
  limit = WEIXIN_SYNC_SEEN_LIMIT,
): string[] {
  if (messageId.trim() === '') return seen;
  if (seen[seen.length - 1] === messageId) return seen;
  seen.push(messageId);
  if (seen.length > limit) seen.splice(0, seen.length - limit);
  return seen;
}
