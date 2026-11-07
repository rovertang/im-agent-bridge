/**
 * Weixin iLink protocol HTTP client.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT).
 *
 * Wire quirks encoded here (all verified against the live service in Step 0):
 *  - Success responses may omit `ret` entirely, and some endpoints
 *    (`sendmessage` tool items) answer with `HTTP 200` + an empty body. Only
 *    an *explicit* non-zero `ret`/`errcode` is treated as a failure.
 *  - `-14` means the bot token/session is no longer valid (re-login needed).
 *  - uint64 identifiers arrive as raw JSON numbers; `parseWeixinJson` quotes
 *    them before `JSON.parse` so no precision is lost.
 *  - `getupdates` is a long-poll: a client-side timeout or a network hiccup is
 *    normal control flow and yields an empty result (the caller just retries).
 */
import { randomBytes } from 'node:crypto';

import type {
  BaseInfo,
  GetBotQrcodeResp,
  GetConfigResp,
  GetQrcodeStatusResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
  SendTypingResp,
} from './types';
import { DEFAULT_ILINK_BOT_TYPE } from './types';

/** Default API origin used before login (and by login itself). */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** `iLink-App-Id` header value used by the official channel build. */
export const WEIXIN_ILINK_APP_ID = 'bot';

/**
 * `iLink-App-ClientVersion` header: a uint32 encoded as `0x00MMNNPP`.
 * `132106` = 0x0002040A = v2.4.10, i.e. the vendored plugin version.
 */
export const WEIXIN_ILINK_APP_CLIENT_VERSION = 132106;

/** `channel_version` reported in `base_info`. */
export const WEIXIN_CHANNEL_VERSION = '2.4.10';

/** Server error code meaning the bot token is dead; the account must re-login. */
export const WEIXIN_TOKEN_EXPIRED_CODE = -14;

/** Long-poll timeout for `getupdates` (the server may hold the request). */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Regular API request timeout (`sendmessage`, QR code fetch). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Lightweight API request timeout (`getconfig`, `sendtyping`, notify). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** Options shared by every authenticated Weixin API call. */
export interface WeixinApiOptions {
  baseUrl: string;
  /** Bot token issued at login; omitted for the unauthenticated QR endpoints. */
  token?: string;
  timeoutMs?: number;
  /** External cancellation (channel stop / shutdown). */
  abortSignal?: AbortSignal;
  /** Overrides the default `base_info` payload. */
  baseInfo?: BaseInfo;
}

/** Protocol-level failure: an explicit non-zero `ret`/`errcode`. */
export class WeixinApiError extends Error {
  readonly endpoint: string;
  readonly ret: number | undefined;
  readonly errcode: number | undefined;

  constructor(endpoint: string, resp: { ret?: number; errcode?: number; errmsg?: string }) {
    const detail = resp.errmsg ? ` errmsg=${resp.errmsg}` : '';
    super(
      `weixin API ${endpoint} failed: ret=${resp.ret ?? 0} errcode=${resp.errcode ?? 0}${detail}`,
    );
    this.name = 'WeixinApiError';
    this.endpoint = endpoint;
    this.ret = resp.ret;
    this.errcode = resp.errcode;
  }

  /** True for the `-14` session-expired code (either field). */
  get tokenExpired(): boolean {
    return this.ret === WEIXIN_TOKEN_EXPIRED_CODE || this.errcode === WEIXIN_TOKEN_EXPIRED_CODE;
  }
}

/**
 * Default `base_info` attached to every outgoing request.
 *
 * `bot_agent` is observability-only; callers may override it (e.g. with the
 * bridge package/version) through {@link WeixinApiOptions.baseInfo}.
 */
export function buildWeixinBaseInfo(overrides?: BaseInfo): BaseInfo {
  return {
    channel_version: WEIXIN_CHANNEL_VERSION,
    bot_agent: 'im-agent-bridge',
    ...overrides,
  };
}

/** A parsed JSON body, or `{}` when the server answered with an empty body. */
function parseJsonOrEmpty<T>(rawText: string): T {
  return parseWeixinJson<T>(rawText);
}

/** Raise {@link WeixinApiError} when the response carries an explicit failure code. */
function assertWeixinSuccess(
  endpoint: string,
  resp: { ret?: number; errcode?: number; errmsg?: string } | undefined,
): void {
  if (!resp) return;
  if (resp.ret !== undefined && resp.ret !== 0) throw new WeixinApiError(endpoint, resp);
  if (resp.errcode !== undefined && resp.errcode !== 0) throw new WeixinApiError(endpoint, resp);
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** `X-WECHAT-UIN`: random uint32 → decimal string → base64. */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': WEIXIN_ILINK_APP_ID,
    'iLink-App-ClientVersion': String(WEIXIN_ILINK_APP_CLIENT_VERSION),
  };
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  const trimmed = token?.trim();
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`;
  return headers;
}

/** State of a single request: external signal + internal timeout controller. */
interface AbortScope {
  signal?: AbortSignal;
  cleanup(): void;
}

function createAbortScope(
  timeoutMs: number | undefined,
  external: AbortSignal | undefined,
): AbortScope {
  const controller =
    timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : undefined;
  const timer =
    controller && timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  const onExternalAbort = (): void => controller?.abort();

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (controller && external) external.removeEventListener('abort', onExternalAbort);
  };

  if (!external) {
    return controller ? { signal: controller.signal, cleanup } : { cleanup };
  }
  if (!controller) return { signal: external, cleanup };
  if (external.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup };
  }
  external.addEventListener('abort', onExternalAbort, { once: true });
  return { signal: controller.signal, cleanup };
}

/** A request descriptor shared by the GET/POST helpers. */
export interface WeixinRequest {
  baseUrl: string;
  /** Path relative to `baseUrl`; may itself carry a query string. */
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Extra query parameters (undefined values are skipped). */
  query?: Record<string, string | undefined>;
  /** Label used in error messages; defaults to the endpoint. */
  label?: string;
}

function buildUrl(req: WeixinRequest): URL {
  const url = new URL(req.endpoint, ensureTrailingSlash(req.baseUrl));
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}

async function fetchText(
  method: 'GET' | 'POST',
  req: WeixinRequest & { body?: string },
): Promise<string> {
  const url = buildUrl(req);
  const label = req.label ?? `${method} ${req.endpoint}`;
  const scope = createAbortScope(req.timeoutMs, req.abortSignal);
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: buildHeaders(req.token),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(scope.signal ? { signal: scope.signal } : {}),
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return rawText;
  } finally {
    scope.cleanup();
  }
}

/** POST a JSON body and return the raw response text (empty body allowed). */
export async function postJson(req: WeixinRequest & { body: string }): Promise<string> {
  return fetchText('POST', req);
}

/** GET a URL and return the raw response text (empty body allowed). */
export async function getJson(req: WeixinRequest): Promise<string> {
  return fetchText('GET', req);
}

/**
 * Parse a Weixin API JSON body, quoting uint64 identifier fields first.
 *
 * The service encodes `message_id` / `msg_id` / `svr_id` / `seq` as raw JSON
 * numbers larger than `Number.MAX_SAFE_INTEGER`; letting `JSON.parse` see them
 * silently corrupts the low digits. This scanner rewrites only actual object
 * property values (never text inside strings), then parses the result.
 */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id', 'seq']);

export function parseWeixinJson<T>(rawText: string): T {
  if (!rawText || rawText.trim() === '') return {} as T;

  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    // Copy the string token verbatim (keys and values alike).
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    // Only rewrite when this string is a key followed by `:`.
    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++];

    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
    const isNumber =
      cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-');
    if (isNumber) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      // Value is already a string/null/etc.: re-scan from the value start.
      index = numberStart;
    }
  }

  return JSON.parse(output) as T;
}

// ---------------------------------------------------------------------------
// getupdates — long-poll
// ---------------------------------------------------------------------------

/**
 * Long-poll `ilink/bot/getupdates`.
 *
 * Client-side timeouts and network errors are normal for a long-poll and are
 * reported as an empty result so the caller simply retries. An explicit
 * protocol error (e.g. `-14` session expired) is thrown as
 * {@link WeixinApiError} — that is the only signal worth acting on.
 */
export async function getUpdates(
  params: GetUpdatesReq & WeixinApiOptions & { longPollTimeoutMs?: number },
): Promise<GetUpdatesResp> {
  const timeoutMs = params.longPollTimeoutMs ?? params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await postJson({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      label: 'getUpdates',
      token: params.token,
      timeoutMs,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? '',
        base_info: buildWeixinBaseInfo(params.baseInfo),
      }),
    });
    const resp = parseJsonOrEmpty<GetUpdatesResp>(rawText);
    assertWeixinSuccess('getUpdates', resp);
    return resp;
  } catch (err) {
    if (err instanceof WeixinApiError) throw err;
    // Timeout / abort / transient network failure: nothing to report.
    return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
  }
}

// ---------------------------------------------------------------------------
// sendmessage — append-only outbound
// ---------------------------------------------------------------------------

/**
 * Send exactly one message. Every call must carry a fresh `client_id` (the
 * idempotency key); the bridge never patches an already-sent message.
 *
 * A success response may be `{}`, omit `ret`, or be an empty body — all are
 * treated as success.
 */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<SendMessageResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    label: 'sendMessage',
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({
      ...params.body,
      base_info: buildWeixinBaseInfo(params.baseInfo),
    }),
  });
  const resp = parseJsonOrEmpty<SendMessageResp>(rawText);
  assertWeixinSuccess('sendMessage', resp);
  return resp;
}

// ---------------------------------------------------------------------------
// getconfig / sendtyping — typing indicator
// ---------------------------------------------------------------------------

/** Fetch bot config (notably `typing_ticket`) for a given WeChat user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    label: 'getConfig',
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildWeixinBaseInfo(params.baseInfo),
    }),
  });
  const resp = parseJsonOrEmpty<GetConfigResp>(rawText);
  assertWeixinSuccess('getConfig', resp);
  return resp;
}

/** Show (`status: 1`) or cancel (`status: 2`) a typing indicator. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<SendTypingResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    label: 'sendTyping',
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({
      ...params.body,
      base_info: buildWeixinBaseInfo(params.baseInfo),
    }),
  });
  const resp = parseJsonOrEmpty<SendTypingResp>(rawText);
  assertWeixinSuccess('sendTyping', resp);
  return resp;
}

// ---------------------------------------------------------------------------
// notify start/stop — channel lifecycle
// ---------------------------------------------------------------------------

/** Tell the server this channel client is starting. */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    label: 'notifyStart',
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({ base_info: buildWeixinBaseInfo(params.baseInfo) }),
  });
  const resp = parseJsonOrEmpty<NotifyStartResp>(rawText);
  assertWeixinSuccess('notifyStart', resp);
  return resp;
}

/** Tell the server this channel client is stopping. */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    label: 'notifyStop',
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({ base_info: buildWeixinBaseInfo(params.baseInfo) }),
  });
  const resp = parseJsonOrEmpty<NotifyStopResp>(rawText);
  assertWeixinSuccess('notifyStop', resp);
  return resp;
}

// ---------------------------------------------------------------------------
// QR login endpoints
// ---------------------------------------------------------------------------

/** Fetch a login QR code. `localTokenList` lets the server skip re-binding. */
export async function getBotQrcode(
  params: {
    baseUrl?: string;
    botType?: string;
    localTokenList?: readonly string[];
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<GetBotQrcodeResp> {
  const rawText = await postJson({
    baseUrl: params.baseUrl ?? DEFAULT_WEIXIN_BASE_URL,
    endpoint: 'ilink/bot/get_bot_qrcode',
    label: 'getBotQrcode',
    query: { bot_type: params.botType ?? DEFAULT_ILINK_BOT_TYPE },
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    body: JSON.stringify({ local_token_list: [...(params.localTokenList ?? [])] }),
  });
  const resp = parseJsonOrEmpty<GetBotQrcodeResp>(rawText);
  assertWeixinSuccess('getBotQrcode', resp);
  if (!resp.qrcode) throw new Error('getBotQrcode: server returned no qrcode handle');
  return resp;
}

/**
 * Long-poll the login QR status.
 *
 * Like the upstream client, client-side timeouts and gateway/network errors
 * are reported as `wait` so the login loop keeps polling.
 */
export async function getQrcodeStatus(params: {
  qrcode: string;
  baseUrl?: string;
  verifyCode?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<GetQrcodeStatusResp> {
  try {
    const rawText = await getJson({
      baseUrl: params.baseUrl ?? DEFAULT_WEIXIN_BASE_URL,
      endpoint: 'ilink/bot/get_qrcode_status',
      label: 'getQrcodeStatus',
      query: {
        qrcode: params.qrcode,
        ...(params.verifyCode ? { verify_code: params.verifyCode } : {}),
      },
      timeoutMs: params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
    const resp = parseJsonOrEmpty<GetQrcodeStatusResp>(rawText);
    if (!resp.status) return { status: 'wait' };
    return resp;
  } catch {
    // Long-poll timeout / transient gateway error: treat as "keep waiting".
    return { status: 'wait' };
  }
}
