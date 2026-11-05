/**
 * Inbound long-poll transport tests: dispatch/filtering/dedupe, cursor
 * persistence, token-expiry stop, backoff and graceful abort of an in-flight
 * long-poll.
 *
 * All HTTP is mocked through the shared `weixin-fetch-mock` helper; the
 * "long poll" answers with a promise that only settles when the transport
 * aborts it, exactly like a real held request. Nothing here touches the
 * network.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WeixinAccount } from '../../../src/channel/weixin';
import {
  WEIXIN_SYNC_SEEN_LIMIT,
  WeixinTokenExpiredError,
  loadWeixinSync,
  rememberWeixinMessageId,
  saveWeixinSync,
  startWeixinTransport,
  weixinSyncPath,
  type WeixinInboundMessage,
  type WeixinTransport,
  type WeixinTransportStatus,
} from '../../../src/channel/weixin';
import {
  bodyOf,
  callsTo,
  installFetchMock,
  jsonResponse,
  pendingUntilAbort,
  type FetchCall,
  type FetchReply,
} from './weixin-fetch-mock';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const ACCOUNT: WeixinAccount = {
  id: '4f0d9c1e@im.test',
  token: 'test-bot-token',
  baseUrl: BASE_URL,
  userId: 'owner@im.test',
  name: 'wx-bridge-bot',
  loggedInAt: '2025-01-02T03:04:05.000Z',
};

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weixin-transport-test-'));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fake iLink server
// ---------------------------------------------------------------------------

type PollReply = () => FetchReply | Promise<FetchReply>;

interface ServerHarness {
  calls: FetchCall[];
  statuses: WeixinTransportStatus[];
  /** Queued `getupdates` answers; an empty queue behaves like a held long-poll. */
  queue: PollReply[];
  getUpdatesCalls(): FetchCall[];
  notifyStartCalls(): FetchCall[];
  notifyStopCalls(): FetchCall[];
  /** Wall-clock ms at which each `getupdates` request was issued. */
  getUpdatesTimes: number[];
}

function installServer(options: { notifyStart?: FetchReply } = {}): ServerHarness {
  const queue: PollReply[] = [];
  const statuses: WeixinTransportStatus[] = [];
  const getUpdatesTimes: number[] = [];
  const { calls } = installFetchMock((call) => {
    switch (call.url.pathname) {
      case '/ilink/bot/msg/notifystart':
        return options.notifyStart ?? jsonResponse({ ret: 0 });
      case '/ilink/bot/msg/notifystop':
        return jsonResponse({ ret: 0 });
      case '/ilink/bot/getupdates': {
        getUpdatesTimes.push(Date.now());
        const next = queue.shift();
        return next ? next() : pendingUntilAbort(call);
      }
      default:
        throw new Error(`unexpected fetch: ${call.method} ${call.url.pathname}`);
    }
  });
  return {
    calls,
    statuses,
    queue,
    getUpdatesTimes,
    getUpdatesCalls: () => callsTo(calls, '/ilink/bot/getupdates'),
    notifyStartCalls: () => callsTo(calls, '/ilink/bot/msg/notifystart'),
    notifyStopCalls: () => callsTo(calls, '/ilink/bot/msg/notifystop'),
  };
}

/** A raw `getupdates` body; raw text keeps uint64 ids lossless. */
function pollBody(payload: string): PollReply {
  return () => ({ body: payload });
}

/**
 * A user message as raw JSON text. `rawId` keeps numeric ids verbatim so the
 * uint64-quoting path is exercised end to end.
 */
function userMessageJson(id: string, options: { rawId?: boolean } = {}): string {
  const messageId = options.rawId ? id : JSON.stringify(id);
  return (
    `{"message_id":${messageId},"message_type":1,` +
    `"from_user_id":"user@im.test","context_token":"ctx-1",` +
    `"item_list":[{"type":1,"text_item":{"text":"hello"}}]}`
  );
}

function pollWith(messages: string[], buf?: string): PollReply {
  const bufPart = buf === undefined ? '' : `,"get_updates_buf":${JSON.stringify(buf)}`;
  return () => ({ body: `{"msgs":[${messages.join(',')}]${bufPart}}` });
}

interface StartedTransport {
  transport: WeixinTransport;
  received: WeixinInboundMessage[];
}

async function start(
  server: ServerHarness,
  profileDir: string,
  overrides: Partial<Parameters<typeof startWeixinTransport>[0]> = {},
): Promise<StartedTransport> {
  const received: WeixinInboundMessage[] = [];
  const transport = await startWeixinTransport({
    account: ACCOUNT,
    profileDir,
    onMessage: (msg) => {
      received.push(msg);
    },
    onStatus: (status) => {
      server.statuses.push(status);
    },
    retryDelayMs: 1,
    backoffMs: 20,
    emptyPollDelayMs: 0,
    ...overrides,
  });
  return { transport, received };
}

// ---------------------------------------------------------------------------
// dispatch / filtering / dedupe
// ---------------------------------------------------------------------------

describe('weixin inbound transport dispatch', () => {
  it('delivers a user message with peer/contextToken and dedupes its id', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    server.queue.push(
      pollWith([userMessageJson('7390000000000000001', { rawId: true })], 'buf-1'),
      // Same message replayed by the server on the next poll: must be skipped.
      pollWith([userMessageJson('7390000000000000001', { rawId: true })], 'buf-2'),
    );

    const { transport, received } = await start(server, profileDir);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // Let the second poll (which replays the id) complete before asserting.
    await vi.waitFor(() => expect(server.getUpdatesTimes.length).toBeGreaterThanOrEqual(2));
    expect(received).toHaveLength(1);

    const inbound = received[0];
    expect(inbound?.peer).toBe('user@im.test');
    expect(inbound?.contextToken).toBe('ctx-1');
    expect(inbound?.message.message_id).toBe('7390000000000000001');
    expect(inbound?.message.item_list?.[0]?.text_item?.text).toBe('hello');
    expect(typeof inbound?.receivedAt).toBe('number');

    // Cursor from poll #1 is threaded into poll #2's request body.
    const calls = server.getUpdatesCalls();
    expect(bodyOf<{ get_updates_buf: string }>(calls[0]).get_updates_buf).toBe('');
    expect(bodyOf<{ get_updates_buf: string }>(calls[1]).get_updates_buf).toBe('buf-1');

    await transport.stop();
  });

  it('ignores bot messages and malformed messages', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    const botMessage =
      '{"message_id":"bot-1","message_type":2,"from_user_id":"other-bot@im.test"}';
    const missingId = '{"message_type":1,"from_user_id":"user@im.test"}';
    const missingPeer = '{"message_id":"no-peer","message_type":1}';
    server.queue.push(pollWith([botMessage, missingId, missingPeer, userMessageJson('user-1')]));

    const { transport, received } = await start(server, profileDir);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.message.message_id).toBe('user-1');
    await transport.stop();
  });

  it('keeps the loop running when the handler throws, without replaying', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    server.queue.push(
      pollWith([userMessageJson('throw-1')]),
      pollWith([userMessageJson('throw-1')]),
    );
    const handlerCalls: string[] = [];
    const { transport } = await start(server, profileDir, {
      onMessage: (msg) => {
        handlerCalls.push(msg.message.message_id ?? '');
        throw new Error('runner exploded');
      },
    });

    await vi.waitFor(() => expect(server.getUpdatesTimes.length).toBeGreaterThanOrEqual(2));
    expect(handlerCalls).toEqual(['throw-1']);
    expect(server.statuses).toContain('error');

    await transport.stop();
  });

  it('resumes the cursor and the dedupe ring after a restart', async () => {
    const profileDir = await makeProfileDir();
    const firstServer = installServer();
    firstServer.queue.push(pollWith([userMessageJson('seen-1')], 'cursor-1'));
    const first = await start(firstServer, profileDir);
    await vi.waitFor(() => expect(first.received).toHaveLength(1));
    await vi.waitFor(async () => {
      const state = await loadWeixinSync(profileDir, ACCOUNT.id);
      expect(state?.buf).toBe('cursor-1');
      expect(state?.seenMessageIds).toContain('seen-1');
    });
    await first.transport.stop();

    vi.unstubAllGlobals();
    const secondServer = installServer();
    secondServer.queue.push(
      pollWith([userMessageJson('seen-1'), userMessageJson('fresh-1')], 'cursor-2'),
    );
    const second = await start(secondServer, profileDir);

    // The replayed id is skipped; only the new message is delivered.
    await vi.waitFor(() => expect(second.received).toHaveLength(1));
    expect(second.received[0]?.message.message_id).toBe('fresh-1');
    expect(
      bodyOf<{ get_updates_buf: string }>(secondServer.getUpdatesCalls()[0]).get_updates_buf,
    ).toBe('cursor-1');

    await second.transport.stop();
  });
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('weixin transport lifecycle', () => {
  it('notifies start/stop, exposes the port and is idempotent', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    const { transport } = await start(server, profileDir);

    expect(server.statuses).toEqual(['starting', 'online']);
    expect(transport.account.id).toBe(ACCOUNT.id);
    expect(transport.port.kind).toBe('weixin');
    expect(transport.port.identity).toEqual({ id: ACCOUNT.id, name: ACCOUNT.name });

    const startCall = server.notifyStartCalls()[0];
    expect(startCall?.method).toBe('POST');
    expect(startCall?.headers.authorization).toBe(`Bearer ${ACCOUNT.token}`);
    expect(
      bodyOf<{ base_info: { channel_version: string } }>(startCall).base_info.channel_version,
    ).toBe('2.4.10');

    // Wait until the loop is actually holding a long-poll, then stop twice.
    await vi.waitFor(() => expect(server.getUpdatesCalls()).toHaveLength(1));
    await transport.stop();
    await transport.stop();

    expect(server.statuses).toEqual(['starting', 'online', 'stopped']);
    expect(server.notifyStopCalls()).toHaveLength(1);
    await expect(transport.done).resolves.toBeUndefined();
  });

  it('rolls back cleanly when notifystart fails', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer({ notifyStart: jsonResponse({ ret: -14, errmsg: 'bad token' }) });

    await expect(start(server, profileDir)).rejects.toThrow(/ret=-14/);
    expect(server.statuses).toEqual(['starting', 'error']);
    expect(server.getUpdatesCalls()).toHaveLength(0);
    expect(server.notifyStopCalls()).toHaveLength(0);
    await expect(stat(weixinSyncPath(profileDir, ACCOUNT.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

// ---------------------------------------------------------------------------
// token expiry + graceful stop
// ---------------------------------------------------------------------------

describe('weixin transport failure handling', () => {
  it('stops on -14, reports token-expired and surfaces it from stop()', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    server.queue.push(() => jsonResponse({ ret: -14, errmsg: 'session timeout' }));

    const { transport } = await start(server, profileDir);
    await vi.waitFor(() => expect(server.statuses).toContain('token-expired'));
    await transport.done;

    expect(transport.error).toBeInstanceOf(WeixinTokenExpiredError);
    expect(server.getUpdatesCalls()).toHaveLength(1);

    await expect(transport.stop()).rejects.toThrow(/token expired/i);
    expect(server.notifyStopCalls()).toHaveLength(1);
    expect(server.statuses).toContain('stopped');
    // Second stop is a no-op (idempotent) even after the fatal error surfaced.
    await transport.stop();
  });

  it('aborts an in-flight long-poll promptly on stop()', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    const { transport } = await start(server, profileDir);
    await vi.waitFor(() => expect(server.getUpdatesCalls()).toHaveLength(1));

    const pendingCall = server.getUpdatesCalls()[0];
    expect(pendingCall?.signal?.aborted).toBe(false);

    const startedAt = Date.now();
    await transport.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(pendingCall?.signal?.aborted).toBe(true);
    expect(server.notifyStopCalls()).toHaveLength(1);
  });

  it('backs off after three consecutive non-token failures', async () => {
    const profileDir = await makeProfileDir();
    const server = installServer();
    server.queue.push(
      () => jsonResponse({ ret: 500, errmsg: 'boom' }),
      () => jsonResponse({ ret: 500, errmsg: 'boom' }),
      () => jsonResponse({ ret: 500, errmsg: 'boom' }),
    );

    const { transport } = await start(server, profileDir, { backoffMs: 60, retryDelayMs: 1 });
    // Three failures consume the queue; the fourth poll is the held long-poll
    // that can only be issued after the 60 ms backoff.
    await vi.waitFor(() => expect(server.getUpdatesTimes.length).toBeGreaterThanOrEqual(4));

    const times = server.getUpdatesTimes;
    const gap = (times[3] ?? 0) - (times[2] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(30);

    expect(server.statuses.filter((status) => status === 'error')).toHaveLength(3);

    await transport.stop();
  });
});

// ---------------------------------------------------------------------------
// sync store
// ---------------------------------------------------------------------------

describe('weixin sync store', () => {
  it('round-trips buf and seen ids with 0600 permissions', async () => {
    const profileDir = await makeProfileDir();
    const saved = await saveWeixinSync(profileDir, ACCOUNT.id, {
      buf: 'cursor-abc',
      seenMessageIds: ['a', 'b', 'b'],
      updatedAt: 1700000000000,
    });
    expect(saved.seenMessageIds).toEqual(['a', 'b']);

    const loaded = await loadWeixinSync(profileDir, ACCOUNT.id);
    expect(loaded).toEqual(saved);

    const filePath = weixinSyncPath(profileDir, ACCOUNT.id);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(filePath.endsWith('4f0d9c1e-im.test.sync.json')).toBe(true);

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      buf: string;
      updatedAt: number;
    };
    expect(raw.buf).toBe('cursor-abc');
    expect(raw.updatedAt).toBe(1700000000000);
  });

  it('caps the seen ring at the configured limit', async () => {
    const seen: string[] = [];
    for (let index = 0; index < WEIXIN_SYNC_SEEN_LIMIT + 25; index += 1) {
      rememberWeixinMessageId(seen, `id-${index}`);
    }
    expect(seen).toHaveLength(WEIXIN_SYNC_SEEN_LIMIT);
    expect(seen[0]).toBe('id-25');
    expect(seen[seen.length - 1]).toBe(`id-${WEIXIN_SYNC_SEEN_LIMIT + 24}`);

    const profileDir = await makeProfileDir();
    const loaded = await saveWeixinSync(profileDir, ACCOUNT.id, {
      buf: '',
      seenMessageIds: seen,
    });
    expect(loaded.seenMessageIds).toHaveLength(WEIXIN_SYNC_SEEN_LIMIT);
  });

  it('returns undefined for a missing or corrupt sync file', async () => {
    const profileDir = await makeProfileDir();
    expect(await loadWeixinSync(profileDir, ACCOUNT.id)).toBeUndefined();

    const filePath = weixinSyncPath(profileDir, ACCOUNT.id);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(join(profileDir, 'weixin'), { recursive: true });
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await loadWeixinSync(profileDir, ACCOUNT.id)).toBeUndefined();
  });
});
