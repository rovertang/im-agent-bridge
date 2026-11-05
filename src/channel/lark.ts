/**
 * Lark/Feishu implementation of {@link ChannelPort}.
 *
 * This is a deliberately thin adapter: it owns the semantic-payload →
 * `@larksuite/channel` `SendInput` translation and nothing else. All
 * Feishu-specific behaviour that the bridge still talks to directly
 * (chat mode lookups, cards, comments, meetings, media downloads) stays on
 * the raw channel, reachable through {@link LarkChannelPort.raw} and gated by
 * the capability table.
 *
 * Keeping this file boring is the point: it is the seam that lets the rest of
 * the codebase compile against a channel-neutral type without changing any
 * Lark behaviour.
 */
import type {
  LarkChannel,
  MarkdownStreamController,
  SendInput,
  SendOptions,
  StreamInput,
} from '@larksuite/channel';
import {
  ChannelUnsupportedError,
  type ChannelCapabilities,
  type ChannelIdentity,
  type ChannelPayload,
  type ChannelSendOptions,
  type ChannelSendResult,
  type ChannelStreamController,
  type ChannelStreamRequest,
  type ChannelPort,
} from './port';

/** Capabilities of the Feishu/Lark channel. Everything is supported today. */
export const LARK_CAPABILITIES: ChannelCapabilities = {
  inbound: {
    media: true,
    mentions: true,
    quotes: true,
    threads: true,
    reactions: true,
  },
  outbound: {
    markdown: true,
    card: true,
    media: true,
    streaming: 'card',
    recall: true,
    typing: true,
  },
  features: {
    chatManagement: true,
    managedCards: true,
    appCredentials: true,
    meetings: true,
    comments: true,
  },
};

/**
 * The Lark port, plus the raw SDK channel for the Feishu-only call sites
 * (`createChat`, `createCard`, `listChats`, `getAppInfo`, `rawClient`, ...).
 *
 * Business code that must stay channel-neutral should depend on
 * {@link ChannelPort}; code that is knowingly Feishu-only can narrow with
 * {@link larkChannelOf} and stay on the SDK types.
 */
export interface LarkChannelPort extends ChannelPort {
  readonly kind: 'lark';
  readonly raw: LarkChannel;
}

class LarkChannelPortImpl implements LarkChannelPort {
  readonly kind = 'lark' as const;
  readonly capabilities = LARK_CAPABILITIES;

  constructor(readonly raw: LarkChannel) {}

  get identity(): ChannelIdentity | undefined {
    // `botIdentity` is populated by connect(); reading it early throws, so the
    // port exposes it as optional instead of letting callers catch.
    try {
      const identity = this.raw.botIdentity;
      if (!identity) return undefined;
      return { id: identity.openId, name: identity.name };
    } catch {
      return undefined;
    }
  }

  async send(
    conversationId: string,
    payload: ChannelPayload,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    const result = await this.raw.send(
      conversationId,
      toSendInput(payload),
      toSendOptions(opts),
    );
    return result.chunkIds
      ? { messageId: result.messageId, chunkIds: result.chunkIds }
      : { messageId: result.messageId };
  }

  async openStream(
    conversationId: string,
    request: ChannelStreamRequest,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    const sendOptions = toSendOptions(opts);
    if (request.mode === 'card') {
      if (!request.initialCard) {
        throw new Error('openStream(mode: "card") requires initialCard');
      }
      const result = await this.raw.stream(
        conversationId,
        {
          card: {
            initial: request.initialCard,
            producer: async (ctrl) => {
              await request.produce(makeCardController(ctrl));
            },
          },
        },
        sendOptions,
      );
      return { messageId: result.messageId };
    }

    const result = await this.raw.stream(
      conversationId,
      {
        markdown: async (ctrl) => {
          await request.produce(makeMarkdownController(ctrl));
        },
      },
      sendOptions,
    );
    return { messageId: result.messageId };
  }

  async recall(messageId: string): Promise<void> {
    await this.raw.recallMessage(messageId);
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    return this.raw.addReaction(messageId, emojiType);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.raw.removeReaction(messageId, reactionId);
  }
}

/** Wrap a Lark channel in its port. One port per connected channel. */
export function createLarkChannelPort(channel: LarkChannel): LarkChannelPort {
  return new LarkChannelPortImpl(channel);
}

/**
 * Narrow a port to the Lark implementation, or `undefined` on any other
 * channel. Used by handlers that genuinely need Feishu-only APIs; they must
 * gate on {@link ChannelCapabilities.features} first so the WeChat path gets a
 * "command not available" reply instead of a crash.
 */
export function larkChannelOf(port: ChannelPort): LarkChannel | undefined {
  return port.kind === 'lark' ? (port as LarkChannelPort).raw : undefined;
}

function makeCardController(ctrl: {
  readonly messageId: string;
  update(next: object | ((current: object) => object)): Promise<void>;
}): ChannelStreamController {
  return {
    messageId: ctrl.messageId,
    async updateCard(card: object): Promise<void> {
      await ctrl.update(card);
    },
    async setMarkdown(): Promise<void> {
      throw new ChannelUnsupportedError('lark', 'setMarkdown on a card stream');
    },
  };
}

function makeMarkdownController(ctrl: MarkdownStreamController): ChannelStreamController {
  return {
    messageId: ctrl.messageId,
    async updateCard(): Promise<void> {
      throw new ChannelUnsupportedError('lark', 'updateCard on a markdown stream');
    },
    async setMarkdown(markdown: string): Promise<void> {
      await ctrl.setContent(markdown);
    },
  };
}

function toSendInput(payload: ChannelPayload): SendInput {
  switch (payload.kind) {
    case 'text':
      return { text: payload.text };
    case 'markdown':
      return { markdown: payload.markdown };
    case 'card':
      return { card: payload.card };
    case 'cardId':
      return { cardId: payload.cardId };
    case 'image':
      return { image: { source: payload.source } };
    case 'file':
      return { file: { source: payload.source, fileName: payload.fileName } };
  }
}

function toSendOptions(opts: ChannelSendOptions | undefined): SendOptions | undefined {
  if (!opts) return undefined;
  // `ChannelMention` is structurally the SDK's `MentionInfo`.
  return opts as SendOptions;
}
