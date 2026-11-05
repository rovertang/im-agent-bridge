/**
 * Weixin implementation of {@link ChannelPort}.
 *
 * Vendored/adapted from @tencent-weixin/openclaw-weixin v2.4.10 (MIT) for the
 * outbound message shape (`messaging/send.ts`, `api/api.ts`) and the typing
 * heartbeat (`api/api.ts` + `sendtyping`), re-expressed as this repo's
 * channel-neutral port.
 *
 * WeChat is append-only: there is no message edit, recall or reaction API, so
 * the port advertises `streaming: 'none'`, `recall: false` and
 * `reactions: false` and throws {@link ChannelUnsupportedError} when a caller
 * ignores that. Every outbound chunk gets a fresh `client_id` (the
 * idempotency key) and is sent with `message_state: FINISH`.
 *
 * Media is not wired yet: the capabilities table advertises `media: false` on
 * both directions until the decrypt/upload pipeline lands, so callers gate on
 * it instead of running into the throw below.
 */
import { randomBytes } from 'node:crypto';

import {
  ChannelUnsupportedError,
  type ChannelCapabilities,
  type ChannelIdentity,
  type ChannelPayload,
  type ChannelPort,
  type ChannelSendOptions,
  type ChannelSendResult,
} from '../port';
import type { WeixinAccount } from './credentials';
import {
  DEFAULT_WEIXIN_BASE_URL,
  getConfig,
  sendMessage,
  sendTyping,
} from './protocol/api';
import {
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
} from './protocol/types';

/** WeChat text messages are not markdown and are capped by the server. */
export const WEIXIN_MAX_TEXT_LENGTH = 4000;

/** How often an active typing indicator is refreshed (server drops it fast). */
const TYPING_HEARTBEAT_MS = 4_000;

/**
 * Minimum gap between two outbound WeChat *messages*. The iLink API enforces an
 * aggressive per-conversation send rate; a tight burst from one agent run can
 * otherwise be dropped or rate-limited server-side.
 */
export const WEIXIN_MIN_SEND_INTERVAL_MS = 300;

/** Serializes outbound messages and enforces a minimum gap between them. */
export interface WeixinOutboundThrottle {
  /** Run `task` after the previous scheduled sends, at least `minInterval` later. */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * FIFO outbound queue used by the port. Exported (with injectable clock) so the
 * rate limit can be unit-tested without real HTTP or real sleeping.
 */
export function createOutboundThrottle(
  minIntervalMs: number = WEIXIN_MIN_SEND_INTERVAL_MS,
  now: () => number = Date.now,
): WeixinOutboundThrottle {
  const interval = Math.max(0, minIntervalMs);
  let tail: Promise<void> = Promise.resolve();
  // `undefined` until the first message: the first send goes out immediately,
  // only subsequent messages wait for the interval.
  let lastSentAt: number | undefined;

  return {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        if (lastSentAt !== undefined) {
          const waitMs = lastSentAt + interval - now();
          if (waitMs > 0) await sleep(waitMs);
        }
        try {
          return await task();
        } finally {
          lastSentAt = now();
        }
      };
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Capabilities of the WeChat (iLink bot) channel. */
export const WEIXIN_CAPABILITIES: ChannelCapabilities = {
  inbound: {
    // Only text items reach agent runs today (see `extractInboundText`); the
    // inbound image/file decrypt pipeline is not implemented yet.
    media: false,
    mentions: false,
    quotes: true,
    threads: false,
    reactions: false,
  },
  outbound: {
    markdown: false,
    card: false,
    // `send()` rejects image/file payloads until the upload pipeline lands.
    media: false,
    streaming: 'none',
    recall: false,
    typing: true,
  },
  features: {
    chatManagement: false,
    managedCards: false,
    appCredentials: false,
    meetings: false,
    comments: false,
  },
  maxTextLength: WEIXIN_MAX_TEXT_LENGTH,
};

/** Handle returned by {@link WeixinChannelPort.startTyping}. */
export interface WeixinTypingHandle {
  /** Cancel the heartbeat and ask the server to clear the indicator. */
  stop(): Promise<void>;
}

/**
 * The WeChat port plus its one channel-specific extension.
 *
 * `startTyping` is not part of {@link ChannelPort} because Lark models typing
 * as a reaction; WeChat has a dedicated `sendtyping` CGI that needs a ticket
 * and a 4 s heartbeat, so it stays on the concrete port.
 */
export interface WeixinChannelPort extends ChannelPort {
  readonly kind: 'weixin';
  /** Show a typing indicator for `conversationId` until `stop()` is called. */
  startTyping(conversationId: string): Promise<WeixinTypingHandle>;
}

/** Fresh idempotency key for one outbound message. `client_id` is a string. */
export function newWeixinClientId(): string {
  return `weixin:${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Best-effort markdown → plain text for channels that render text only.
 *
 * Deliberately naive: tables, task lists and language-tagged fences are not
 * normalised yet. Good enough to keep the port honest until a fuller renderer
 * is worth its weight.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    // Fenced code blocks: keep the code, drop the fence markers.
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/^[ \t]*```.*$/gm, '')
    // Inline code, images and links.
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Headings, block quotes, horizontal rules.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    // Emphasis / strikethrough (keep single `*`/`_` untouched: snake_case!).
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    // List bullets become a printable dot; ordered markers are kept.
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
}

/**
 * Split text into chunks of at most `maxLength` characters, preferring line
 * boundaries; a single over-long line is hard-split.
 */
export function splitWeixinText(text: string, maxLength = WEIXIN_MAX_TEXT_LENGTH): string[] {
  if (!text) return [];
  if (maxLength <= 0) throw new Error('weixin: maxLength must be positive');
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  const flush = (): void => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };

  for (const line of lines) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    flush();
    let rest = line;
    while (rest.length > maxLength) {
      chunks.push(rest.slice(0, maxLength));
      rest = rest.slice(maxLength);
    }
    current = rest;
  }
  flush();
  return chunks;
}

interface SendTextOutcome {
  /** Server-assigned id when the response carried one. */
  serverMessageId?: string;
  /** The idempotency key used for this request. */
  clientId: string;
}

class WeixinChannelPortImpl implements WeixinChannelPort {
  readonly kind = 'weixin' as const;
  readonly capabilities = WEIXIN_CAPABILITIES;
  readonly identity: ChannelIdentity;

  private readonly baseUrl: string;
  private readonly typingTickets = new Map<string, string>();
  private readonly outbound = createOutboundThrottle();

  constructor(private readonly account: WeixinAccount) {
    this.baseUrl = account.baseUrl.trim() || DEFAULT_WEIXIN_BASE_URL;
    this.identity = {
      id: account.id,
      ...(account.name ? { name: account.name } : {}),
    };
  }

  async send(
    conversationId: string,
    payload: ChannelPayload,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    const text = this.toOutboundText(payload);
    if (text === '') throw new Error('weixin: refusing to send an empty message');

    const chunks = splitWeixinText(text, WEIXIN_MAX_TEXT_LENGTH);
    const outcomes: SendTextOutcome[] = [];
    for (const chunk of chunks) {
      // Every chunk is its own WeChat message, so it goes through the same
      // rate limiter as separate send() calls.
      outcomes.push(
        await this.outbound.schedule(() =>
          this.sendText(conversationId, chunk, opts?.contextToken),
        ),
      );
    }

    const messageIds = outcomes.map(
      (outcome) => outcome.serverMessageId ?? outcome.clientId,
    );
    const messageId = messageIds[messageIds.length - 1];
    if (messageId === undefined) throw new Error('weixin: no message was sent');
    return {
      messageId,
      ...(messageIds.length > 1 ? { chunkIds: messageIds } : {}),
    };
  }

  async openStream(): Promise<ChannelSendResult> {
    // Append-only channel: callers must gate on `streaming !== 'none'`.
    throw new ChannelUnsupportedError('weixin', 'message streaming');
  }

  async recall(): Promise<void> {
    throw new ChannelUnsupportedError('weixin', 'message recall');
  }

  async addReaction(): Promise<string | undefined> {
    throw new ChannelUnsupportedError('weixin', 'reactions');
  }

  async removeReaction(): Promise<void> {
    throw new ChannelUnsupportedError('weixin', 'reactions');
  }

  async startTyping(conversationId: string): Promise<WeixinTypingHandle> {
    const ticket = await this.resolveTypingTicket(conversationId);
    if (!ticket) {
      throw new Error(`weixin: typing ticket unavailable for conversation ${conversationId}`);
    }
    await this.sendTypingStatus(conversationId, ticket, TypingStatus.TYPING);

    const timer = setInterval(() => {
      void this.sendTypingStatus(conversationId, ticket, TypingStatus.TYPING).catch(
        () => undefined,
      );
    }, TYPING_HEARTBEAT_MS);
    timer.unref();

    let stopped = false;
    return {
      stop: async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try {
          await this.sendTypingStatus(conversationId, ticket, TypingStatus.CANCEL);
        } catch {
          // Best effort: a failed cancel must never fail the caller's run.
        }
      },
    };
  }

  /** Translate a semantic payload to text, or reject unsupported kinds. */
  private toOutboundText(payload: ChannelPayload): string {
    switch (payload.kind) {
      case 'text':
        return payload.text;
      case 'markdown':
        return markdownToPlainText(payload.markdown).trim();
      default:
        // card / cardId / image / file need the media-upload pipeline, which
        // does not exist yet; capabilities.media is false for that reason.
        throw new ChannelUnsupportedError('weixin', `outbound payload "${payload.kind}"`);
    }
  }

  private async sendText(
    conversationId: string,
    text: string,
    contextToken?: string,
  ): Promise<SendTextOutcome> {
    const clientId = newWeixinClientId();
    const response = await sendMessage({
      baseUrl: this.baseUrl,
      token: this.account.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: conversationId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
    });
    const serverMessageId = response.message_id?.trim();
    return {
      clientId,
      ...(serverMessageId ? { serverMessageId } : {}),
    };
  }

  /** `typing_ticket` is stable per WeChat user, so cache it per conversation. */
  private async resolveTypingTicket(conversationId: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(conversationId);
    if (cached) return cached;
    const response = await getConfig({
      baseUrl: this.baseUrl,
      token: this.account.token,
      ilinkUserId: conversationId,
    });
    const ticket = response.typing_ticket?.trim();
    if (ticket) this.typingTickets.set(conversationId, ticket);
    return ticket || undefined;
  }

  private async sendTypingStatus(
    conversationId: string,
    typingTicket: string,
    status: number,
  ): Promise<void> {
    await sendTyping({
      baseUrl: this.baseUrl,
      token: this.account.token,
      body: {
        ilink_user_id: conversationId,
        typing_ticket: typingTicket,
        status,
      },
    });
  }
}

/** Wrap a logged-in WeChat account in its channel port. */
export function createWeixinChannelPort(account: WeixinAccount): WeixinChannelPort {
  return new WeixinChannelPortImpl(account);
}
