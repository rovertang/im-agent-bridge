/**
 * Weixin QR-code login state machine.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT): the
 * status machine (including IDC redirect, SMS verification code and QR
 * refresh) mirrors `auth/login-qr.ts`, but UI concerns are inverted — instead
 * of writing to stdout it reports the QR through `onQr` so the CLI can own
 * presentation.
 *
 * States: wait → scaned → (need_verifycode)* → confirmed, plus the terminal
 * `expired` / `verify_code_blocked` (refresh, max 3 times), `binded_redirect`
 * (already bound, no new credentials) and `scaned_but_redirect` (switch the
 * polling host and keep going).
 */
import qrcodeTerminal from 'qrcode-terminal';

import { listWeixinAccounts } from '../credentials';
import {
  DEFAULT_WEIXIN_BASE_URL,
  getBotQrcode,
  getQrcodeStatus,
} from './api';
import { DEFAULT_ILINK_BOT_TYPE, type GetQrcodeStatusResp } from './types';

/** Maximum number of QR refreshes (official client behaviour). */
const MAX_QR_REFRESH_COUNT = 3;
/** Default overall login deadline. */
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
/** Delay between status polls once a poll returns with a status. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Client-side timeout for one long-poll status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** How many local tokens are offered to the server to avoid duplicate binding. */
const MAX_LOCAL_TOKEN_LIST = 10;

/** QR content handed to the caller's presentation layer. */
export interface WeixinQrInfo {
  /** Content to encode (normally a URL the user can also open manually). */
  content: string;
  /** Ready-to-print ASCII QR rendered with `qrcode-terminal`. */
  ascii: string;
}

export interface WeixinLoginOptions {
  /** Profile state dir; local tokens are read from its weixin account index. */
  profileDir: string;
  /** `bot_type` passed to `get_bot_qrcode` (defaults to the official value). */
  botType?: string;
  /** Called once per issued QR (initial + each refresh). */
  onQr(info: WeixinQrInfo): void | Promise<void>;
  /** Ask the user for the number shown on their phone (SMS verification). */
  readVerifyCode(): Promise<string | undefined>;
  /** Overall deadline for the whole flow. */
  timeoutMs?: number;
  /** Delay between polls (tests shrink this). */
  pollIntervalMs?: number;
  /** Maximum QR refreshes before giving up. */
  maxQrRefresh?: number;
}

/** Successful login result: everything needed to persist a {@link WeixinAccount}. */
export interface WeixinLoginResult {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  /**
   * Reserved marker for callers that prefer a flag over
   * {@link WeixinAlreadyConnectedError}. Currently the state machine throws
   * instead of returning `true`, so a success result never sets it.
   */
  alreadyConnected?: boolean;
}

/** Expected login failure (expired, blocked, timeout, incomplete response). */
export class WeixinLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeixinLoginError';
  }
}

/**
 * The scanned bot is already bound to this WeChat account (`binded_redirect`):
 * no new credentials are issued and the existing local credentials stay valid.
 * Callers should treat this as "already connected", not as a transport error.
 */
export class WeixinAlreadyConnectedError extends WeixinLoginError {
  readonly alreadyConnected = true;
  readonly accountId?: string;
  readonly userId?: string;

  constructor(details: { accountId?: string; userId?: string } = {}) {
    super(
      'weixin login: this bot is already bound to the scanned WeChat account ' +
        '(binded_redirect); existing local credentials remain valid',
    );
    this.name = 'WeixinAlreadyConnectedError';
    if (details.accountId) this.accountId = details.accountId;
    if (details.userId) this.userId = details.userId;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Render the QR as ASCII. Falls back to the raw content if rendering fails. */
async function renderAsciiQr(content: string): Promise<string> {
  try {
    return await new Promise<string>((resolve) => {
      qrcodeTerminal.generate(content, { small: true }, (qrcode) => {
        resolve(qrcode);
      });
    });
  } catch {
    return content;
  }
}

/** Tokens of the newest locally stored accounts, offered to avoid re-binding. */
async function collectLocalTokenList(profileDir: string): Promise<string[]> {
  try {
    const accounts = await listWeixinAccounts(profileDir);
    return accounts
      .slice(-MAX_LOCAL_TOKEN_LIST)
      .map((account) => account.token.trim())
      .filter((token) => token !== '');
  } catch {
    return [];
  }
}

interface IssuedQr {
  /** Opaque handle polled against `get_qrcode_status`. */
  qrcode: string;
  /** Content encoded in the QR (also printed as a fallback link). */
  content: string;
}

async function issueQr(botType: string, localTokenList: readonly string[]): Promise<IssuedQr> {
  const response = await getBotQrcode({
    baseUrl: DEFAULT_WEIXIN_BASE_URL,
    botType,
    localTokenList,
  });
  const content = response.qrcode_img_content?.trim() || response.qrcode;
  return { qrcode: response.qrcode, content };
}

async function announceQr(
  qr: IssuedQr,
  onQr: WeixinLoginOptions['onQr'],
): Promise<void> {
  await onQr({ content: qr.content, ascii: await renderAsciiQr(qr.content) });
}

/** Turn `redirect_host` into a base URL, tolerating a host with a scheme. */
function redirectBaseUrl(redirectHost: string): string {
  const host = redirectHost.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${host}`;
}

/**
 * Run the full QR login flow and resolve with the issued credentials.
 *
 * Throws {@link WeixinAlreadyConnectedError} on `binded_redirect` and
 * {@link WeixinLoginError} for every other non-success terminal state; the
 * caller decides whether to persist the credentials.
 */
export async function loginWeixinAccount(
  opts: WeixinLoginOptions,
): Promise<WeixinLoginResult> {
  const botType = opts.botType?.trim() || DEFAULT_ILINK_BOT_TYPE;
  const timeoutMs = Math.max(opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, 1_000);
  const pollIntervalMs = Math.max(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 0);
  const maxQrRefresh = Math.max(opts.maxQrRefresh ?? MAX_QR_REFRESH_COUNT, 0);

  const localTokenList = await collectLocalTokenList(opts.profileDir);
  const deadline = Date.now() + timeoutMs;

  let apiBaseUrl = DEFAULT_WEIXIN_BASE_URL;
  let qr = await issueQr(botType, localTokenList);
  await announceQr(qr, opts.onQr);

  let qrRefreshCount = 0;
  let pendingVerifyCode: string | undefined;
  /** Short-lived codes that already came back rejected (avoids a tight loop). */
  let lastRejectedVerifyCode: string | undefined;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(deadline - Date.now(), 1_000);
    let statusResponse: GetQrcodeStatusResp;
    try {
      statusResponse = await getQrcodeStatus({
        baseUrl: apiBaseUrl,
        qrcode: qr.qrcode,
        ...(pendingVerifyCode ? { verifyCode: pendingVerifyCode } : {}),
        timeoutMs: Math.min(QR_LONG_POLL_TIMEOUT_MS, remainingMs),
      });
    } catch {
      // Defensive: getQrcodeStatus already maps network errors to `wait`.
      statusResponse = { status: 'wait' };
    }

    switch (statusResponse.status) {
      case 'wait':
        break;

      case 'scaned':
        // A previously submitted verification code was accepted.
        pendingVerifyCode = undefined;
        lastRejectedVerifyCode = undefined;
        break;

      case 'need_verifycode': {
        const code = (await opts.readVerifyCode())?.trim();
        if (!code) {
          throw new WeixinLoginError(
            'weixin login: the WeChat client requires a verification code, but none was provided',
          );
        }
        if (pendingVerifyCode && code === lastRejectedVerifyCode) {
          throw new WeixinLoginError(
            'weixin login: the same verification code was entered twice; aborting',
          );
        }
        if (pendingVerifyCode) lastRejectedVerifyCode = pendingVerifyCode;
        pendingVerifyCode = code;
        // Re-poll immediately; the code is carried in the next request.
        continue;
      }

      case 'expired':
      case 'verify_code_blocked': {
        if (statusResponse.status === 'verify_code_blocked') pendingVerifyCode = undefined;
        if (qrRefreshCount >= maxQrRefresh) {
          throw new WeixinLoginError(
            statusResponse.status === 'verify_code_blocked'
              ? 'weixin login: too many incorrect verification codes; login aborted'
              : `weixin login: the QR code expired ${qrRefreshCount} times; login aborted`,
          );
        }
        qrRefreshCount += 1;
        qr = await issueQr(botType, localTokenList);
        await announceQr(qr, opts.onQr);
        break;
      }

      case 'scaned_but_redirect': {
        const host = statusResponse.redirect_host?.trim();
        if (host) apiBaseUrl = redirectBaseUrl(host);
        break;
      }

      case 'binded_redirect': {
        const accountId = statusResponse.ilink_bot_id?.trim();
        const userId = statusResponse.ilink_user_id?.trim();
        throw new WeixinAlreadyConnectedError({
          ...(accountId ? { accountId } : {}),
          ...(userId ? { userId } : {}),
        });
      }

      case 'confirmed': {
        const accountId = statusResponse.ilink_bot_id?.trim();
        const token = statusResponse.bot_token?.trim();
        if (!accountId || !token) {
          throw new WeixinLoginError(
            'weixin login: confirmed response is missing ilink_bot_id or bot_token',
          );
        }
        const userId = statusResponse.ilink_user_id?.trim();
        const baseUrl = statusResponse.baseurl?.trim() || DEFAULT_WEIXIN_BASE_URL;
        return {
          accountId,
          token,
          baseUrl,
          ...(userId ? { userId } : {}),
        };
      }

      default:
        // Unknown future status: keep polling rather than aborting the login.
        break;
    }

    if (pollIntervalMs > 0) await delay(pollIntervalMs);
  }

  throw new WeixinLoginError('weixin login: timed out waiting for the QR code to be confirmed');
}
