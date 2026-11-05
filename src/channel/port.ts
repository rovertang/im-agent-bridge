/**
 * Channel port — the single surface the bridge's channel-agnostic business
 * layer (commands, reply delivery, rendering hand-off) is allowed to touch.
 *
 * Scope: outbound delivery + identity + capability negotiation. Inbound
 * transport stays inside each channel implementation (Lark: `bot/channel.ts`;
 * WeChat: `channel/weixin/transport.ts`), because the two channels normalise
 * inbound messages very differently and no shared shape is honest yet.
 *
 * Design rules:
 *
 *  1. Payloads are **semantic** (`{ kind: 'markdown', markdown }`), never SDK
 *     shaped, so a channel with weaker capabilities can degrade (markdown →
 *     plain text) instead of leaking `@larksuite/channel` types into the
 *     business layer. The Lark adapter (`channel/lark.ts`) is the only place
 *     that translates to the SDK's `SendInput`.
 *  2. Anything a channel cannot do is declared in {@link ChannelCapabilities}
 *     *and* throws {@link ChannelUnsupportedError} when called anyway, so a
 *     caller that forgets to gate on capabilities fails loudly instead of
 *     silently dropping output.
 *  3. `recall` / reactions / live streaming are optional in practice. The
 *     capabilities table is the single source of truth; handlers gate on it
 *     rather than on `kind === 'lark'` wherever the distinction is really a
 *     capability distinction.
 */

/** Channel implementations the port knows about. */
export type ChannelKind = 'lark' | 'weixin';

/** The bot's own identity on a channel (resolved after the channel connects). */
export interface ChannelIdentity {
  id: string;
  name?: string;
}

/**
 * Coarse, declarative description of what a channel can do.
 *
 * Keep these booleans about *transport mechanics*, not product features:
 * "can this channel edit a message?" belongs here, "does this workspace have
 * a /cd command?" does not.
 */
export interface ChannelCapabilities {
  inbound: {
    /** Inbound images/files/audio/video can be downloaded and handed to agent runs. */
    media: boolean;
    /** Messages can @-mention users/bots and the mention set survives normalisation. */
    mentions: boolean;
    /** Quoted/replied-to messages can be resolved to their original content. */
    quotes: boolean;
    /** Threads/topics exist and can scope a conversation. */
    threads: boolean;
    /** Emoji reactions arrive as events. */
    reactions: boolean;
  };
  outbound: {
    /** Markdown can be rendered natively (headings, bold, code fences). */
    markdown: boolean;
    /** Native interactive cards (buttons, forms, CardKit entities). */
    card: boolean;
    /** Images/files can be uploaded and sent. */
    media: boolean;
    /**
     * How live progress can be shown:
     *  - `card`: create a streamed card and update it in place (Lark)
     *  - `edit`: create a text message and edit it in place
     *  - `none`: append-only — no update channel at all (WeChat, most likely)
     */
    streaming: 'none' | 'edit' | 'card';
    /** A sent message can be recalled/deleted. */
    recall: boolean;
    /** A "typing"/working indicator can be shown (Lark models it as a reaction). */
    typing: boolean;
  };
  /**
   * Feature gates for command families that only make sense on a rich IM
   * channel. A false value means the command handler answers "not available
   * on this channel" instead of exercising Lark-only APIs.
   */
  features: {
    /** createChat / listChats (e.g. `/new chat`, `/invite`). */
    chatManagement: boolean;
    /** CardKit entity lifecycle (managed cards used by `/account`, `/config`, ...). */
    managedCards: boolean;
    /** App credential validation + app scope grants (`/account`, `/doctor`). */
    appCredentials: boolean;
    /** In-meeting agent (join meeting, answer in meeting). */
    meetings: boolean;
    /** Cloud-document comment channel. */
    comments: boolean;
  };
  /** Soft limit for a single outbound text payload, in characters. */
  maxTextLength?: number;
}

/** A mention to attach when sending. `openId`/`userId` are channel-native ids. */
export interface ChannelMention {
  openId?: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
}

export type ChannelPayload =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  /** Raw interactive card (Lark CardKit 2.0 / legacy card JSON). */
  | { kind: 'card'; card: object }
  /** Reference to an existing managed card entity. */
  | { kind: 'cardId'; cardId: string }
  | { kind: 'image'; source: string | Buffer }
  | { kind: 'file'; source: string | Buffer; fileName: string };

export interface ChannelSendOptions {
  /**
   * Conversation context token. Weixin requires the per-inbound-message
   * `context_token` to be echoed on replies; chat channels that route by
   * conversation id alone (Lark) ignore it.
   */
  contextToken?: string;
  /** Reply to this message (threads the reply where the channel supports it). */
  replyTo?: string;
  replyInThread?: boolean;
  mentions?: readonly ChannelMention[];
  /** Rewrite plain `@name` tokens in text/markdown into real mentions. */
  resolveMentionsInText?: boolean;
}

export interface ChannelSendResult {
  messageId: string;
  /** Per-chunk message ids when the channel had to split a long payload. */
  chunkIds?: readonly string[];
}

/** Controller handed to a live-stream producer. Only one method matches `mode`. */
export interface ChannelStreamController {
  readonly messageId: string;
  /** Push a full card snapshot (mode `card`). */
  updateCard(card: object): Promise<void>;
  /** Replace the full markdown body (mode `markdown`). */
  setMarkdown(markdown: string): Promise<void>;
}

export type ChannelStreamMode = 'card' | 'markdown';

export interface ChannelStreamRequest {
  mode: ChannelStreamMode;
  /** Initial card JSON; required for `mode: 'card'`. */
  initialCard?: object;
  /**
   * Producer body: called once the channel has created the live message.
   * Returning/resolving ends the stream; the port's promise resolves when the
   * message is finalised (mirrors the SDK's `stream()` contract).
   */
  produce(controller: ChannelStreamController): Promise<void> | void;
}

/**
 * The port itself.
 *
 * Lark is wired in `channel/lark.ts` and WeChat in `channel/weixin/port.ts`.
 * Calls that a channel does not support must reject with
 * {@link ChannelUnsupportedError} rather than silently succeeding.
 */
export interface ChannelPort {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  /** Undefined until the channel has connected and resolved its own identity. */
  readonly identity: ChannelIdentity | undefined;

  send(
    conversationId: string,
    payload: ChannelPayload,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult>;

  /**
   * Open a message that stays editable for the duration of a run.
   *
   * Channels with `capabilities.outbound.streaming === 'none'` reject this;
   * callers must fall back to a single `send()` at the end of the run.
   */
  openStream(
    conversationId: string,
    request: ChannelStreamRequest,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult>;

  /** Delete a sent message. Rejects when `capabilities.outbound.recall` is false. */
  recall(messageId: string): Promise<void>;

  /** Add a working/typing indicator; returns a handle for removal when supported. */
  addReaction(messageId: string, emojiType: string): Promise<string | undefined>;

  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

/** Thrown by a channel implementation when the caller ignored its capabilities. */
export class ChannelUnsupportedError extends Error {
  readonly channel: ChannelKind;
  readonly capability: string;

  constructor(channel: ChannelKind, capability: string) {
    super(`channel "${channel}" does not support ${capability}`);
    this.name = 'ChannelUnsupportedError';
    this.channel = channel;
    this.capability = capability;
  }
}

/** True when the port advertises the given outbound/feature capability. */
export function supportsOutbound(
  port: ChannelPort,
  capability: keyof ChannelCapabilities['outbound'],
): boolean {
  const value = port.capabilities.outbound[capability];
  return typeof value === 'boolean' ? value : value !== 'none';
}

export function supportsFeature(
  port: ChannelPort,
  feature: keyof ChannelCapabilities['features'],
): boolean {
  return port.capabilities.features[feature];
}
