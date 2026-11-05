/**
 * Weixin channel transport: lifecycle + inbound long-poll loop.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT) for the
 * `getupdates` long-poll loop shape and its failure handling (see upstream
 * `monitor/monitor.ts`): `notifystart` → poll → normalise → dispatch →
 * `notifystop`, with 3-consecutive-failure backoff and `-14` meaning the bot
 * token is dead. Cursor persistence and the message-id ring live in this
 * bridge's profile state (`sync-store.ts`) rather than `~/.openclaw`.
 *
 * Design notes:
 *  - Append-only channel: nothing here edits/patches messages, it only
 *    delivers deduped inbound user messages to `onMessage`.
 *  - `stop()` aborts the in-flight long-poll through an `AbortController`
 *    (the protocol layer passes the signal to `fetch`), waits for the loop to
 *    exit, then notifies the server. It is idempotent.
 *  - Business orchestration (commands, agent runs, typing) does NOT live
 *    here; that is the runner's job (`runtime/weixin-runner.ts`).
 */
import { tmpdir } from 'node:os';

import type { WeixinAccount } from './credentials';
import { createWeixinChannelPort, type WeixinChannelPort } from './port';
import {
  DEFAULT_WEIXIN_BASE_URL,
  WeixinApiError,
  getUpdates,
  notifyStart,
  notifyStop,
} from './protocol/api';
import { MessageType, type WeixinMessage } from './protocol/types';
import {
  WEIXIN_SYNC_SEEN_LIMIT,
  loadWeixinSync,
  rememberWeixinMessageId,
  saveWeixinSync,
} from './sync-store';

/** Lifecycle states reported through {@link WeixinTransportOptions.onStatus}. */
export type WeixinTransportStatus =
  | 'starting'
  | 'online'
  | 'stopped'
  | 'error'
  /** The bot token was rejected (`-14`): re-run `weixin login`. */
  | 'token-expired';

/** One inbound user message handed to the runner. */
export interface WeixinInboundMessage {
  /** Raw protocol message (item_list, ref_msg, …). */
  message: WeixinMessage;
  /** `from_user_id`; use it as `to_user_id` when replying. */
  peer: string;
  /** `message.context_token`; must be echoed back when replying. */
  contextToken?: string;
  /** Epoch ms when this transport received the message. */
  receivedAt: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BACKOFF_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
/**
 * Safety delay between polls when the server answers immediately without
 * messages. A real long-poll holds the request for ~35 s, so this only
 * prevents a hot loop against a misbehaving/mocked server.
 */
const DEFAULT_EMPTY_POLL_DELAY_MS = 1_000;

export interface WeixinTransportOptions {
  account: WeixinAccount;
  /**
   * State directory for the cursor/dedupe file: `<profileDir>/weixin/`.
   * Defaults to `os.tmpdir()` (fine for tests, NOT for the real runtime —
   * callers must pass the profile dir so a restart resumes the cursor).
   */
  profileDir?: string;
  /** Inbound message sink; awaited, errors are reported but never fatal. */
  onMessage?: (msg: WeixinInboundMessage) => void | Promise<void>;
  /** Observe lifecycle changes (never receives secrets). */
  onStatus?: (status: WeixinTransportStatus, detail?: string) => void;
  /** Test seam: delay after a single failed poll (default 2 s). */
  retryDelayMs?: number;
  /** Test seam: delay after 3 consecutive failed polls (default 30 s). */
  backoffMs?: number;
  /** Test seam: safety delay after an immediately-empty poll (default 1 s). */
  emptyPollDelayMs?: number;
}

/** A started Weixin transport (online until `stop()`). */
export interface WeixinTransport {
  readonly account: WeixinAccount;
  readonly port: WeixinChannelPort;
  /** Resolves once the poll loop has stopped; never rejects (see {@link error}). */
  readonly done: Promise<void>;
  /** Fatal error that stopped the loop (currently only token expiry). */
  readonly error: Error | undefined;
  /** Abort the loop, persist the cursor and `notifystop`. Idempotent. */
  stop(): Promise<void>;
}

/** The bot token is no longer valid: the account has to log in again. */
export class WeixinTokenExpiredError extends Error {
  readonly tokenExpired = true;

  constructor(detail?: string) {
    super(
      detail
        ? `weixin bot token expired (${detail}); re-run \`weixin login\``
        : 'weixin bot token expired; re-run `weixin login`',
    );
    this.name = 'WeixinTokenExpiredError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Abort-aware sleep: resolves early (and clears its timer) when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Turn a raw message into an inbound envelope, or `undefined` when it must be
 * ignored: only user messages (`message_type === 1`) with a string
 * `message_id` and a `from_user_id` are deliverable.
 */
function toInboundMessage(
  message: WeixinMessage,
  receivedAt: number,
): WeixinInboundMessage | undefined {
  if (message.message_type !== MessageType.USER) return undefined;
  const messageId = typeof message.message_id === 'string' ? message.message_id.trim() : '';
  if (!messageId) return undefined;
  const peer = typeof message.from_user_id === 'string' ? message.from_user_id.trim() : '';
  if (!peer) return undefined;
  const contextToken =
    typeof message.context_token === 'string' ? message.context_token.trim() : '';
  return {
    message,
    peer,
    ...(contextToken ? { contextToken } : {}),
    receivedAt,
  };
}

/**
 * Bring a WeChat channel online: `notifystart`, then run the inbound
 * long-poll loop until `stop()` (or a fatal token expiry).
 *
 * Throws when `notifystart` fails — nothing is started, no state is written
 * and `notifystop` is not sent.
 */
export async function startWeixinTransport(
  opts: WeixinTransportOptions,
): Promise<WeixinTransport> {
  const { account } = opts;
  const baseUrl = account.baseUrl.trim() || DEFAULT_WEIXIN_BASE_URL;
  const profileDir = opts.profileDir?.trim() || tmpdir();
  const retryDelayMs = Math.max(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, 0);
  const backoffMs = Math.max(opts.backoffMs ?? DEFAULT_BACKOFF_MS, 0);
  const emptyPollDelayMs = Math.max(opts.emptyPollDelayMs ?? DEFAULT_EMPTY_POLL_DELAY_MS, 0);

  const port = createWeixinChannelPort(account);
  const controller = new AbortController();
  const signal = controller.signal;

  /** Observability callbacks must never break delivery. */
  const report = (status: WeixinTransportStatus, detail?: string): void => {
    try {
      opts.onStatus?.(status, detail);
    } catch {
      // Swallow: a broken logger should not stop the channel.
    }
  };

  report('starting');
  try {
    await notifyStart({ baseUrl, token: account.token });
  } catch (err) {
    // Roll back: abort anything we created, do not notify stop, write nothing.
    controller.abort();
    report('error', `weixin: notifystart failed: ${errorMessage(err)}`);
    throw err;
  }

  const persisted = await loadWeixinSync(profileDir, account.id);
  const seenIds = persisted?.seenMessageIds ? [...persisted.seenMessageIds] : [];
  const seenSet = new Set(seenIds);
  let buf = persisted?.buf ?? '';
  let dirty = false;
  let fatalError: Error | undefined;

  const persist = async (): Promise<void> => {
    try {
      await saveWeixinSync(profileDir, account.id, {
        buf,
        seenMessageIds: seenIds,
        updatedAt: Date.now(),
      });
      dirty = false;
    } catch (err) {
      // A failed cursor write must not kill inbound delivery; retry on the
      // next successful poll (or on stop()).
      dirty = true;
      report('error', `weixin: failed to persist sync cursor: ${errorMessage(err)}`);
    }
  };

  report('online');

  const loop = async (): Promise<void> => {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const response = await getUpdates({
          baseUrl,
          token: account.token,
          get_updates_buf: buf,
          abortSignal: signal,
        });
        if (signal.aborted) break;

        consecutiveFailures = 0;
        let changed = false;

        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== buf) {
          buf = response.get_updates_buf;
          changed = true;
        }

        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const raw of messages) {
          const inbound = toInboundMessage(raw, Date.now());
          if (!inbound) continue;
          const messageId = inbound.message.message_id?.trim() ?? '';
          if (!messageId || seenSet.has(messageId)) continue;

          try {
            await opts.onMessage?.(inbound);
          } catch (err) {
            // A failing handler must not stop the loop or replay the message.
            report('error', `weixin: inbound handler failed: ${errorMessage(err)}`);
          }

          seenSet.add(messageId);
          rememberWeixinMessageId(seenIds, messageId, WEIXIN_SYNC_SEEN_LIMIT);
          dirty = true;
          changed = true;
        }

        if (changed) await persist();
        else if (emptyPollDelayMs > 0) await sleep(emptyPollDelayMs, signal);
      } catch (err) {
        if (signal.aborted) break;

        if (err instanceof WeixinApiError && err.tokenExpired) {
          fatalError = new WeixinTokenExpiredError(
            err.errcode === undefined ? `ret=${err.ret ?? '?'}` : `errcode=${err.errcode}`,
          );
          report('token-expired', fatalError.message);
          // Drop out of the loop even if a nested request is still in flight.
          controller.abort();
          break;
        }

        consecutiveFailures += 1;
        report(
          'error',
          `weixin: getUpdates failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ` +
            errorMessage(err),
        );
        const backingOff = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        if (backingOff) consecutiveFailures = 0;
        await sleep(backingOff ? backoffMs : retryDelayMs, signal);
      }
    }
  };

  const done: Promise<void> = loop().catch((err: unknown) => {
    fatalError ??= err instanceof Error ? err : new Error(errorMessage(err));
    report('error', `weixin: inbound loop crashed: ${errorMessage(err)}`);
  });

  let stopped = false;
  return {
    account,
    port,
    done,
    get error(): Error | undefined {
      return fatalError;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      // 1) cancel the in-flight long-poll (fetch gets the abort signal), 2) wait
      // for the loop to unwind, 3) persist the cursor, 4) tell the server.
      controller.abort();
      await done;
      if (dirty) await persist();
      try {
        await notifyStop({ baseUrl, token: account.token });
      } catch (err) {
        report('error', `weixin: notifystop failed: ${errorMessage(err)}`);
      }
      report('stopped');

      // Surface a fatal stop (token expiry) to the owner of the lifecycle,
      // after all cleanup has run so the caller can decide to re-login.
      const fatal = fatalError;
      if (fatal) throw fatal;
    },
  };
}
