import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { createLarkChannelPort, larkChannelOf, LARK_CAPABILITIES } from '../../../src/channel/lark';
import {
  ChannelUnsupportedError,
  supportsFeature,
  supportsOutbound,
  type ChannelCapabilities,
  type ChannelPort,
} from '../../../src/channel/port';
import { createFakeChannel } from '../../helpers/fake-channel';

/**
 * P0 contract tests for the channel port: the Lark adapter must translate the
 * semantic payload union back to exactly the SDK shapes the old call sites
 * used, so switching the business layer to the port is behaviour-preserving.
 */

function makePort(): {
  port: ReturnType<typeof createLarkChannelPort>;
  fake: ReturnType<typeof createFakeChannel>;
} {
  const fake = createFakeChannel();
  const port = createLarkChannelPort(fake as unknown as LarkChannel);
  return { port, fake };
}

describe('LarkChannelPort payload translation', () => {
  it('maps each semantic payload kind onto the SDK SendInput', async () => {
    const { port, fake } = makePort();

    await port.send('oc_chat', { kind: 'text', text: 'plain' });
    await port.send('oc_chat', { kind: 'markdown', markdown: '**md**' });
    await port.send('oc_chat', { kind: 'card', card: { schema: '2.0' } });
    await port.send('oc_chat', { kind: 'cardId', cardId: 'card_1' });
    await port.send('oc_chat', { kind: 'image', source: '/tmp/a.png' });
    await port.send('oc_chat', { kind: 'file', source: Buffer.from('x'), fileName: 'a.txt' });

    expect(fake.sent.map((entry) => entry.content)).toEqual([
      { text: 'plain' },
      { markdown: '**md**' },
      { card: { schema: '2.0' } },
      { cardId: 'card_1' },
      { image: { source: '/tmp/a.png' } },
      { file: { source: expect.any(Buffer), fileName: 'a.txt' } },
    ]);
    expect(fake.sent.every((entry) => entry.chatId === 'oc_chat')).toBe(true);
  });

  it('passes send options straight through', async () => {
    const { port, fake } = makePort();
    await port.send('oc_chat', { kind: 'text', text: 'hi' }, { replyTo: 'om_parent' });
    expect(fake.sent[0]?.options).toEqual({ replyTo: 'om_parent' });
  });

  it('returns the message receipt from the SDK', async () => {
    const { port } = makePort();
    const result = await port.send('oc_chat', { kind: 'text', text: 'hi' });
    expect(result.messageId).toMatch(/^om_fake_/);
  });
});

describe('LarkChannelPort streams', () => {
  it('opens a card stream and routes updateCard to the SDK controller', async () => {
    const { port, fake } = makePort();
    const updates: object[] = [];
    await port.openStream(
      'oc_chat',
      {
        mode: 'card',
        initialCard: { schema: '2.0', body: {} },
        produce: async (ctrl) => {
          expect(typeof ctrl.messageId).toBe('string');
          await ctrl.updateCard({ schema: '2.0', body: { seq: 2 } });
          updates.push({ ok: true });
          await expect(ctrl.setMarkdown('nope')).rejects.toBeInstanceOf(ChannelUnsupportedError);
        },
      },
      { replyTo: 'om_parent' },
    );

    expect(updates).toHaveLength(1);
    expect(fake.streams[0]?.input).toMatchObject({
      card: { initial: { schema: '2.0', body: {} } },
    });
    expect(fake.streams[0]?.cardUpdates).toEqual([{ schema: '2.0', body: { seq: 2 } }]);
    expect(fake.streams[0]?.options).toEqual({ replyTo: 'om_parent' });
  });

  it('opens a markdown stream and routes setMarkdown to setContent', async () => {
    const { port, fake } = makePort();
    await port.openStream('oc_chat', {
      mode: 'markdown',
      produce: async (ctrl) => {
        await ctrl.setMarkdown('# first');
        await ctrl.setMarkdown('# second');
        await expect(ctrl.updateCard({})).rejects.toBeInstanceOf(ChannelUnsupportedError);
      },
    });

    expect(fake.streams[0]?.markdownContents).toEqual(['# first', '# second']);
  });
});

describe('LarkChannelPort lifecycle delegation', () => {
  it('forwards recall and reactions to the SDK', async () => {
    const calls: string[] = [];
    const channel = {
      async recallMessage(messageId: string): Promise<void> {
        calls.push(`recall:${messageId}`);
      },
      async addReaction(messageId: string, emoji: string): Promise<string> {
        calls.push(`add:${messageId}:${emoji}`);
        return 'reaction_1';
      },
      async removeReaction(messageId: string, reactionId: string): Promise<void> {
        calls.push(`remove:${messageId}:${reactionId}`);
      },
      botIdentity: { openId: 'ou_bot', name: 'Bridge Bot' },
    } as unknown as LarkChannel;
    const port = createLarkChannelPort(channel);

    await port.recall('om_1');
    await expect(port.addReaction('om_1', 'Typing')).resolves.toBe('reaction_1');
    await port.removeReaction('om_1', 'reaction_1');
    expect(calls).toEqual(['recall:om_1', 'add:om_1:Typing', 'remove:om_1:reaction_1']);
  });

  it('exposes the bot identity once the channel has connected', () => {
    const channel = {
      botIdentity: { openId: 'ou_bot', name: 'Bridge Bot' },
    } as unknown as LarkChannel;
    expect(createLarkChannelPort(channel).identity).toEqual({
      id: 'ou_bot',
      name: 'Bridge Bot',
    });
  });

  it('reports no identity before connect()', () => {
    const { port } = makePort();
    expect(port.identity).toBeUndefined();
  });

  it('narrows to the raw Lark channel only for lark ports', () => {
    const { port, fake } = makePort();
    expect(larkChannelOf(port)).toBe(fake);
    const textOnly: ChannelPort = { ...port, kind: 'weixin' };
    expect(larkChannelOf(textOnly)).toBeUndefined();
  });
});

describe('ChannelCapabilities helpers', () => {
  const textOnly: ChannelCapabilities = {
    inbound: { media: false, mentions: false, quotes: false, threads: false, reactions: false },
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
  };

  it('reads booleans and the streaming tri-state', () => {
    const port = { capabilities: textOnly } as ChannelPort;
    expect(supportsOutbound(port, 'card')).toBe(false);
    expect(supportsOutbound(port, 'typing')).toBe(true);
    expect(supportsOutbound(port, 'streaming')).toBe(false);
    expect(supportsFeature(port, 'managedCards')).toBe(false);
  });

  it('advertises everything on the Lark channel', () => {
    const port = { capabilities: LARK_CAPABILITIES } as ChannelPort;
    expect(supportsOutbound(port, 'card')).toBe(true);
    expect(supportsOutbound(port, 'streaming')).toBe(true);
    expect(supportsFeature(port, 'chatManagement')).toBe(true);
  });
});
