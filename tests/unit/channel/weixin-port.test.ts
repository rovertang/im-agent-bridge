/**
 * `WeixinChannelPort` + transport tests: capability table, semantic payload
 * handling (text / markdown degradation / long-message chunking), unsupported
 * operations and the typing heartbeat. (Transport lifecycle/poll-loop tests
 * live in `weixin-transport.test.ts`.)
 *
 * All HTTP is mocked; nothing here touches the real network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelUnsupportedError,
  type ChannelCapabilities,
  type ChannelPort,
} from '../../../src/channel/port';
import {
  DEFAULT_WEIXIN_BASE_URL,
  WEIXIN_CAPABILITIES,
  WEIXIN_MAX_TEXT_LENGTH,
  createWeixinChannelPort,
  markdownToPlainText,
  splitWeixinText,
  type WeixinAccount,
} from '../../../src/channel/weixin';
import {
  bodyOf,
  callsTo,
  installFetchMock,
  jsonResponse,
  type FetchCall,
} from './weixin-fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BASE_URL = DEFAULT_WEIXIN_BASE_URL;

function sampleAccount(overrides: Partial<WeixinAccount> = {}): WeixinAccount {
  return {
    id: '4f0d9c1e@im.test',
    token: 'sample-bot-token',
    baseUrl: BASE_URL,
    userId: 'scanner@im.test',
    name: 'bridge-bot',
    loggedInAt: '2025-01-02T03:04:05.000Z',
    ...overrides,
  };
}

const ACCOUNT = sampleAccount();
const CONVERSATION = 'user@im.test';

interface SentTextMessage {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    context_token?: string;
    item_list: Array<{ type: number; text_item?: { text?: string } }>;
  };
  base_info: { channel_version: string };
}

function sentText(call: FetchCall | undefined): string {
  const body = bodyOf<SentTextMessage>(call);
  return body.msg.item_list[0]?.text_item?.text ?? '';
}

function unexpected(call: FetchCall): never {
  throw new Error(`unexpected fetch: ${call.method} ${call.url.pathname}`);
}

// ---------------------------------------------------------------------------
// capabilities + identity
// ---------------------------------------------------------------------------

describe('WeixinChannelPort capabilities', () => {
  it('advertises the WeChat capability table exactly', () => {
    const expected: ChannelCapabilities = {
      inbound: {
        media: false,
        mentions: false,
        quotes: true,
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
    };
    expect(WEIXIN_CAPABILITIES).toEqual(expected);

    const port: ChannelPort = createWeixinChannelPort(ACCOUNT);
    expect(port.kind).toBe('weixin');
    expect(port.capabilities).toBe(WEIXIN_CAPABILITIES);
    expect(port.capabilities.maxTextLength).toBe(WEIXIN_MAX_TEXT_LENGTH);
  });

  it('exposes the logged-in account as its identity', () => {
    const port = createWeixinChannelPort(ACCOUNT);
    expect(port.identity).toEqual({ id: ACCOUNT.id, name: ACCOUNT.name });

    const anonymous = createWeixinChannelPort(sampleAccount({ name: undefined }));
    expect(anonymous.identity).toEqual({ id: ACCOUNT.id });
  });
});

// ---------------------------------------------------------------------------
// send — text / markdown / chunking / unsupported payloads
// ---------------------------------------------------------------------------

describe('WeixinChannelPort.send', () => {
  it('sends a text message with a fresh client_id per send', async () => {
    // Raw body: JSON.stringify would already lose the uint64 precision.
    const { calls } = installFetchMock(() => ({ body: '{"message_id":7390000000000000001}' }));
    const port = createWeixinChannelPort(ACCOUNT);

    const first = await port.send(CONVERSATION, { kind: 'text', text: 'hello' });
    const second = await port.send(CONVERSATION, { kind: 'text', text: 'again' });

    const sends = callsTo(calls, '/ilink/bot/sendmessage');
    expect(sends).toHaveLength(2);
    expect(sentText(sends[0])).toBe('hello');
    expect(sentText(sends[1])).toBe('again');

    const body0 = bodyOf<SentTextMessage>(sends[0]);
    const body1 = bodyOf<SentTextMessage>(sends[1]);
    expect(body0.msg.to_user_id).toBe(CONVERSATION);
    expect(body0.msg.from_user_id).toBe('');
    expect(body0.msg.message_type).toBe(2);
    expect(body0.msg.message_state).toBe(2);
    expect(body0.msg.item_list[0]?.type).toBe(1);
    expect(body0.msg.client_id).toMatch(/^weixin:/);
    expect(body0.msg.client_id).not.toBe(body1.msg.client_id);

    // The server id is preferred when issued, the client id is the fallback.
    expect(first.messageId).toBe('7390000000000000001');
    expect(second.messageId).toBe('7390000000000000001');
  });

  it('falls back to the client_id when the server sends an empty 200', async () => {
    const { calls } = installFetchMock(() => ({ body: '' }));
    const port = createWeixinChannelPort(ACCOUNT);
    const result = await port.send(CONVERSATION, { kind: 'text', text: 'hi' });
    const body = bodyOf<SentTextMessage>(callsTo(calls, '/ilink/bot/sendmessage')[0]);
    expect(result.messageId).toBe(body.msg.client_id);
  });

  it('degrades markdown to plain text', async () => {
    const { calls } = installFetchMock(() => ({ body: '' }));
    const port = createWeixinChannelPort(ACCOUNT);
    await port.send(CONVERSATION, {
      kind: 'markdown',
      markdown: '## Title\n\n**bold** and `code` and [link](https://example.com)\n- item',
    });
    expect(sentText(callsTo(calls, '/ilink/bot/sendmessage')[0])).toBe(
      'Title\n\nbold and code and link\n• item',
    );
  });

  it('splits long text on line boundaries, one client_id per chunk', async () => {
    const { calls } = installFetchMock(() => jsonResponse({ message_id: 99 }));
    const port = createWeixinChannelPort(ACCOUNT);
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index} ${'x'.repeat(60)}`);
    const text = lines.join('\n');

    const result = await port.send(CONVERSATION, { kind: 'text', text });

    const sends = callsTo(calls, '/ilink/bot/sendmessage');
    expect(sends.length).toBeGreaterThan(1);
    const chunkTexts = sends.map((call) => sentText(call));
    expect(chunkTexts.join('\n')).toBe(text);
    for (const chunk of chunkTexts) expect(chunk.length).toBeLessThanOrEqual(WEIXIN_MAX_TEXT_LENGTH);

    const clientIds = sends.map((call) => bodyOf<SentTextMessage>(call).msg.client_id);
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(result.chunkIds).toHaveLength(sends.length);
    expect(result.messageId).toBe('99');
  });

  it('puts every chunk of a single over-long line under the limit', () => {
    const chunks = splitWeixinText('x'.repeat(9_001), 4_000);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4_000, 4_000, 1_001]);
    expect(chunks.join('')).toBe('x'.repeat(9_001));
  });

  it('rejects payload kinds WeChat cannot deliver yet', async () => {
    installFetchMock(() => ({ body: '' }));
    const port = createWeixinChannelPort(ACCOUNT);

    for (const payload of [
      { kind: 'card', card: { schema: '2.0' } },
      { kind: 'cardId', cardId: 'card_1' },
      { kind: 'image', source: '/tmp/a.png' },
      { kind: 'file', source: '/tmp/a.txt', fileName: 'a.txt' },
    ] as const) {
      await expect(port.send(CONVERSATION, payload)).rejects.toBeInstanceOf(
        ChannelUnsupportedError,
      );
    }
  });

  it('refuses to send an empty message', async () => {
    installFetchMock(() => ({ body: '' }));
    const port = createWeixinChannelPort(ACCOUNT);
    await expect(port.send(CONVERSATION, { kind: 'text', text: '' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// unsupported port operations
// ---------------------------------------------------------------------------

describe('WeixinChannelPort unsupported operations', () => {
  it('throws ChannelUnsupportedError for streams, recall and reactions', async () => {
    const port = createWeixinChannelPort(ACCOUNT);
    await expect(
      port.openStream(CONVERSATION, { mode: 'markdown', produce: () => undefined }),
    ).rejects.toBeInstanceOf(ChannelUnsupportedError);
    await expect(port.recall('msg-1')).rejects.toBeInstanceOf(ChannelUnsupportedError);
    await expect(port.addReaction('msg-1', 'OK')).rejects.toBeInstanceOf(
      ChannelUnsupportedError,
    );
    await expect(port.removeReaction('msg-1', 'reaction-1')).rejects.toBeInstanceOf(
      ChannelUnsupportedError,
    );
  });
});

// ---------------------------------------------------------------------------
// typing indicator
// ---------------------------------------------------------------------------

describe('WeixinChannelPort.startTyping', () => {
  function installTypingServer(): { calls: FetchCall[]; ticketRequests: () => FetchCall[] } {
    const { calls } = installFetchMock((call) => {
      if (call.url.pathname === '/ilink/bot/getconfig') {
        return jsonResponse({ typing_ticket: 'ticket-1' });
      }
      if (call.url.pathname === '/ilink/bot/sendtyping') {
        return jsonResponse({});
      }
      return unexpected(call);
    });
    return { calls, ticketRequests: () => callsTo(calls, '/ilink/bot/getconfig') };
  }

  function typingStatuses(calls: readonly FetchCall[]): number[] {
    return callsTo(calls, '/ilink/bot/sendtyping').map((call) => {
      const body = bodyOf<{ status?: number; ilink_user_id?: string }>(call);
      return body.status ?? 0;
    });
  }

  it('sends an immediate indicator, heartbeats every 4s and cancels on stop', async () => {
    vi.useFakeTimers();
    const server = installTypingServer();
    const port = createWeixinChannelPort(ACCOUNT);

    const handle = await port.startTyping(CONVERSATION);
    expect(server.ticketRequests()).toHaveLength(1);
    const ticketCall = server.ticketRequests()[0];
    expect(ticketCall?.url.pathname).toBe('/ilink/bot/getconfig');
    expect(bodyOf<{ ilink_user_id: string }>(ticketCall).ilink_user_id).toBe(CONVERSATION);

    expect(typingStatuses(server.calls)).toEqual([1]);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(typingStatuses(server.calls)).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(typingStatuses(server.calls)).toEqual([1, 1, 1]);

    await handle.stop();
    expect(typingStatuses(server.calls)).toEqual([1, 1, 1, 2]);

    // The heartbeat is cancelled: no more typing requests after stop().
    await vi.advanceTimersByTimeAsync(12_000);
    expect(typingStatuses(server.calls)).toHaveLength(4);
  });

  it('caches the typing ticket per conversation', async () => {
    vi.useFakeTimers();
    const server = installTypingServer();
    const port = createWeixinChannelPort(ACCOUNT);

    const first = await port.startTyping(CONVERSATION);
    await first.stop();
    const second = await port.startTyping(CONVERSATION);
    await second.stop();

    expect(server.ticketRequests()).toHaveLength(1);
  });

  it('fails clearly when the server issues no typing ticket', async () => {
    installFetchMock((call) => {
      if (call.url.pathname === '/ilink/bot/getconfig') return jsonResponse({ ret: 0 });
      return unexpected(call);
    });
    const port = createWeixinChannelPort(ACCOUNT);
    await expect(port.startTyping(CONVERSATION)).rejects.toThrow(/typing ticket/);
  });
});

// ---------------------------------------------------------------------------
// markdown degradation (unit)
// ---------------------------------------------------------------------------

describe('markdownToPlainText', () => {
  it('strips common markdown constructs', () => {
    expect(markdownToPlainText('# H1\n\n**b** ~~s~~ `c`\n> q\n\n![alt](a.png)')).toBe(
      'H1\n\nb s c\nq\n\nalt',
    );
  });

  it('keeps snake_case intact', () => {
    expect(markdownToPlainText('some_snake_case and *italic*')).toBe(
      'some_snake_case and *italic*',
    );
  });

  it('keeps fenced code content without the fence', () => {
    expect(markdownToPlainText('```ts\nconst a = 1;\n```')).toBe('const a = 1;\n');
  });
});
