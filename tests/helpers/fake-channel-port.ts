/**
 * Tests helpers for the channel port.
 *
 * Integration tests build command contexts and bridge instances against a
 * `FakeChannel` (a structural stand-in for `@larksuite/channel`'s
 * `LarkChannel`). The business layer now talks to a `ChannelPort`, so tests
 * wrap the same fake in the production Lark adapter — that way the tests keep
 * asserting on `channel.sent` / `channel.streams` while also exercising the
 * real payload translation in `src/channel/lark.ts`.
 */
import type { LarkChannel } from '@larksuite/channel';
import { createLarkChannelPort, type LarkChannelPort } from '../../src/channel/lark';
import type { ChannelPort } from '../../src/channel/port';
import type { FakeChannel } from './fake-channel';

export function createFakeChannelPort(channel: FakeChannel): LarkChannelPort {
  return createLarkChannelPort(channel as unknown as LarkChannel);
}

/**
 * A port that advertises the capabilities of a plain-text, append-only channel
 * (the WeChat shape) while delegating sends to a `FakeChannel` so assertions
 * can still read what the business layer tried to send.
 *
 * Used to prove capability gating without needing the WeChat transport.
 */
export function createFakeTextOnlyChannelPort(channel: FakeChannel): ChannelPort {
  const larkPort = createFakeChannelPort(channel);
  return {
    kind: 'weixin',
    capabilities: {
      inbound: {
        media: false,
        mentions: false,
        quotes: false,
        threads: false,
        reactions: false,
      },
      outbound: {
        markdown: false,
        card: false,
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
      maxTextLength: 4000,
    },
    identity: { id: 'wx-bot', name: 'weixin-bot' },
    // Minimal delegation: text/markdown go through the Lark adapter so the
    // fake records a real send; unsupported payload kinds are rejected.
    async send(conversationId, payload, opts) {
      if (payload.kind === 'card' || payload.kind === 'cardId') {
        throw new Error(`channel "weixin" does not support cards (${payload.kind})`);
      }
      if (payload.kind === 'image' || payload.kind === 'file') {
        throw new Error(`channel "weixin" does not support media (${payload.kind})`);
      }
      return larkPort.send(conversationId, payload, opts);
    },
    async openStream() {
      throw new Error('channel "weixin" does not support streaming');
    },
    async recall() {
      throw new Error('channel "weixin" does not support recall');
    },
    async addReaction() {
      return 'fake-reaction';
    },
    async removeReaction() {
      /* no-op */
    },
  };
}
