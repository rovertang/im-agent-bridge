import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WEIXIN_QUOTE_LIMIT,
  WeixinQuoteStore,
  weixinQuoteStorePath,
} from '../../../src/channel/weixin';

const roots: string[] = [];
const stores: WeixinQuoteStore[] = [];

afterEach(async () => {
  // Persistence is scheduled asynchronously; settle it before removing the
  // profile dir so the cleanup cannot race a pending write.
  await Promise.allSettled(stores.splice(0).map((store) => store.flush()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpProfileDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-weixin-quotes-'));
  roots.push(root);
  return join(root, 'profiles', 'wx');
}

const ACCOUNT = '4f0d@im.test';
const PEER = 'user-1@im.test';

describe('weixin quote store', () => {
  it('remembers user and bot messages by id and finds them again', async () => {
    const profileDir = await tmpProfileDir();
    const store = new WeixinQuoteStore(profileDir, ACCOUNT, { now: () => 1_000 });
    stores.push(store);
    await store.load();

    store.record(PEER, { id: 'm1', text: 'hello from user', kind: 'user' });
    store.record(PEER, { id: 'm2', text: 'hello from bot', kind: 'bot' });

    expect(store.find(PEER, 'm1')).toMatchObject({ text: 'hello from user', kind: 'user' });
    expect(store.find(PEER, 'm2')).toMatchObject({ text: 'hello from bot', kind: 'bot' });
    expect(store.find(PEER, 'missing')).toBeUndefined();
    expect(store.find('other-peer@im.test', 'm1')).toBeUndefined();
  });

  it('caps each conversation bucket and evicts the oldest entries', async () => {
    const profileDir = await tmpProfileDir();
    const store = new WeixinQuoteStore(profileDir, ACCOUNT, { limit: 3 });
    stores.push(store);
    await store.load();

    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      store.record(PEER, { id, text: `text ${id}`, kind: 'user' });
    }

    expect(store.entries(PEER).map((entry) => entry.id)).toEqual(['m2', 'm3', 'm4']);
    expect(store.find(PEER, 'm1')).toBeUndefined();
    expect(WEIXIN_QUOTE_LIMIT).toBe(500);
  });

  it('persists to 0600 and reloads in a fresh store instance', async () => {
    const profileDir = await tmpProfileDir();
    const first = new WeixinQuoteStore(profileDir, ACCOUNT, { now: () => 42 });
    stores.push(first);
    await first.load();
    first.record(PEER, { id: 'm1', text: 'persisted user text', kind: 'user' });
    first.record(PEER, { id: 'm2', text: 'persisted bot text', kind: 'bot' });
    await first.flush();

    const file = weixinQuoteStorePath(profileDir);
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; buckets: object };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.buckets)).toHaveLength(1);

    const second = new WeixinQuoteStore(profileDir, ACCOUNT);
    stores.push(second);
    await second.load();
    expect(second.find(PEER, 'm1')?.text).toBe('persisted user text');
    expect(second.find(PEER, 'm2')?.text).toBe('persisted bot text');
  });

  it('buckets history per account so two bots never share quotes', async () => {
    const profileDir = await tmpProfileDir();
    const store = new WeixinQuoteStore(profileDir, ACCOUNT);
    stores.push(store);
    await store.load();
    store.record(PEER, { id: 'm1', text: 'account A text', kind: 'user' });
    await store.flush();

    const other = new WeixinQuoteStore(profileDir, 'other-account@im.test');
    stores.push(other);
    await other.load();
    expect(other.find(PEER, 'm1')).toBeUndefined();
    expect(other.entries(PEER)).toHaveLength(0);
  });
});
