/**
 * Protocol-layer tests for the vendored Weixin iLink client: JSON parsing
 * (uint64 losslessness), the HTTP request/response conventions (empty 200 =
 * success, missing `ret` = success, explicit `-14` = token dead), the QR login
 * state machine and the credential store.
 *
 * All HTTP is mocked; nothing here touches the real network.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearWeixinAccount,
  listWeixinAccounts,
  loadWeixinAccount,
  safeWeixinAccountId,
  saveWeixinAccount,
  type WeixinAccount,
} from '../../../src/channel/weixin/credentials';
import {
  DEFAULT_WEIXIN_BASE_URL,
  WEIXIN_CHANNEL_VERSION,
  WeixinApiError,
  getUpdates,
  parseWeixinJson,
  sendMessage,
} from '../../../src/channel/weixin/protocol/api';
import {
  WeixinAlreadyConnectedError,
  WeixinLoginError,
  loginWeixinAccount,
  type WeixinQrInfo,
} from '../../../src/channel/weixin/protocol/login';
import {
  DEFAULT_ILINK_BOT_TYPE,
  type GetQrcodeStatusResp,
} from '../../../src/channel/weixin/protocol/types';
import {
  bodyOf,
  callsTo,
  installFetchMock,
  jsonResponse,
  type FetchCall,
  type FetchReply,
} from './weixin-fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BASE_URL = DEFAULT_WEIXIN_BASE_URL;

function unexpected(call: FetchCall): never {
  throw new Error(`unexpected fetch: ${call.method} ${call.url.pathname}`);
}

// ---------------------------------------------------------------------------
// parseWeixinJson — uint64 losslessness
// ---------------------------------------------------------------------------

describe('parseWeixinJson', () => {
  it('quotes uint64 id fields so large ids keep every digit', () => {
    const raw =
      '{"ret":0,"msgs":[{"message_id":7390000000000000001,"seq":9007199254740993,' +
      '"svr_id":123456789012345678,"msg_id":42,"create_time_ms":1712345678901,' +
      '"item_list":[{"msg_id":7}],"msg":"id 12345678901234567890 stays text"}],' +
      '"get_updates_buf":"buf"}';

    const parsed = parseWeixinJson<{
      ret?: number;
      msgs?: Array<{
        message_id?: string;
        seq?: string;
        svr_id?: string;
        msg_id?: string;
        create_time_ms?: number;
        item_list?: Array<{ msg_id?: string }>;
        msg?: string;
      }>;
      get_updates_buf?: string;
    }>(raw);

    const message = parsed.msgs?.[0];
    expect(message?.message_id).toBe('7390000000000000001');
    expect(message?.seq).toBe('9007199254740993');
    expect(message?.svr_id).toBe('123456789012345678');
    expect(message?.msg_id).toBe('42');
    expect(message?.item_list?.[0]?.msg_id).toBe('7');
    // Non-uint64 numbers must keep their JSON type.
    expect(message?.create_time_ms).toBe(1712345678901);
    expect(parsed.ret).toBe(0);
    // Text inside a string is never rewritten.
    expect(message?.msg).toBe('id 12345678901234567890 stays text');
    expect(parsed.get_updates_buf).toBe('buf');
  });

  it('treats an empty or whitespace body as an empty object', () => {
    expect(parseWeixinJson('')).toEqual({});
    expect(parseWeixinJson('   \n')).toEqual({});
  });

  it('leaves values that are already strings untouched', () => {
    const parsed = parseWeixinJson<{ message_id?: string; ret?: number }>(
      '{"message_id":"7390000000000000001","ret":0}',
    );
    expect(parsed.message_id).toBe('7390000000000000001');
    expect(parsed.ret).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — request shape + lenient success handling
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('posts the append-only message shape with the official headers', async () => {
    const { calls } = installFetchMock(() => ({ body: '' }));
    const result = await sendMessage({
      baseUrl: BASE_URL,
      token: 'token-abc',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: 'user@im.test',
          client_id: 'client-1',
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
          context_token: 'ctx-1',
        },
      },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected one request');
    expect(call.method).toBe('POST');
    expect(call.url.origin + call.url.pathname).toBe(`${BASE_URL}/ilink/bot/sendmessage`);
    expect(call.headers.authorization).toBe('Bearer token-abc');
    expect(call.headers['ilink-app-id']).toBe('bot');
    expect(call.headers['ilink-app-clientversion']).toBe('132106');
    expect(call.headers.authorizationtype).toBe('ilink_bot_token');
    expect(call.headers['x-wechat-uin']).toMatch(/^[A-Za-z0-9+/=]+$/);

    const body = bodyOf<{
      msg: {
        to_user_id: string;
        client_id: string;
        message_type: number;
        message_state: number;
        context_token: string;
        item_list: Array<{ type: number; text_item: { text: string } }>;
      };
      base_info: { channel_version: string; bot_agent: string };
    }>(call);
    expect(body.msg.to_user_id).toBe('user@im.test');
    expect(body.msg.client_id).toBe('client-1');
    expect(body.msg.message_type).toBe(2);
    expect(body.msg.message_state).toBe(2);
    expect(body.msg.context_token).toBe('ctx-1');
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }]);
    expect(body.base_info.channel_version).toBe(WEIXIN_CHANNEL_VERSION);
    expect(typeof body.base_info.bot_agent).toBe('string');

    // Empty HTTP 200 body: success, no message id issued.
    expect(result).toEqual({});
  });

  it('accepts a response without ret and returns the server message id', async () => {
    // Raw body: building this through JSON.stringify would already round the
    // uint64 down to a float, which is exactly the bug the parser prevents.
    installFetchMock(() => ({ body: '{"message_id":7390000000000000001}' }));
    const result = await sendMessage({
      baseUrl: BASE_URL,
      token: 't',
      body: { msg: { to_user_id: 'u', client_id: 'c' } },
    });
    expect(result.message_id).toBe('7390000000000000001');
  });

  it('throws a token-expired WeixinApiError on ret=-14', async () => {
    installFetchMock(() => jsonResponse({ ret: -14, errmsg: 'session timeout' }));
    const error = await sendMessage({
      baseUrl: BASE_URL,
      token: 'expired',
      body: { msg: { to_user_id: 'u', client_id: 'c' } },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WeixinApiError);
    expect((error as WeixinApiError).tokenExpired).toBe(true);
    expect((error as WeixinApiError).ret).toBe(-14);
  });
});

// ---------------------------------------------------------------------------
// getUpdates — long-poll semantics
// ---------------------------------------------------------------------------

describe('getUpdates', () => {
  it('parses a success response that has no ret and a big message id', async () => {
    installFetchMock(() => ({
      body:
        '{"msgs":[{"message_id":7390000000000000001,"from_user_id":"user@im.test"}],' +
        '"get_updates_buf":"next-buf"}',
    }));
    const response = await getUpdates({
      baseUrl: BASE_URL,
      token: 't',
      get_updates_buf: 'old-buf',
    });
    expect(response.msgs?.[0]?.message_id).toBe('7390000000000000001');
    expect(response.msgs?.[0]?.from_user_id).toBe('user@im.test');
    expect(response.get_updates_buf).toBe('next-buf');
  });

  it('returns an empty result on a network error (long-poll retry)', async () => {
    installFetchMock(() => {
      throw new TypeError('fetch failed');
    });
    const response = await getUpdates({
      baseUrl: BASE_URL,
      token: 't',
      get_updates_buf: 'old-buf',
    });
    expect(response).toEqual({ ret: 0, msgs: [], get_updates_buf: 'old-buf' });
  });

  it('rethrows an explicit protocol error instead of swallowing it', async () => {
    installFetchMock(() => jsonResponse({ ret: -14, errmsg: 'session expired' }));
    await expect(
      getUpdates({ baseUrl: BASE_URL, token: 'dead', get_updates_buf: '' }),
    ).rejects.toMatchObject({ name: 'WeixinApiError', ret: -14 });
  });
});

// ---------------------------------------------------------------------------
// loginWeixinAccount — QR state machine
// ---------------------------------------------------------------------------

interface LoginHarness {
  calls: FetchCall[];
  qrRequests(): FetchCall[];
  statusRequests(): FetchCall[];
}

function installLoginServer(options: {
  statuses: GetQrcodeStatusResp[];
  qr?: { qrcode: string; qrcode_img_content: string };
}): LoginHarness {
  let qrCount = 0;
  const statuses = [...options.statuses];
  const { calls } = installFetchMock((call): FetchReply => {
    if (call.url.pathname === '/ilink/bot/get_bot_qrcode') {
      qrCount += 1;
      const qr = options.qr ?? {
        qrcode: `qr-${qrCount}`,
        qrcode_img_content: `https://weixin.qq.com/x?q=qr-${qrCount}`,
      };
      return jsonResponse(qr);
    }
    if (call.url.pathname === '/ilink/bot/get_qrcode_status') {
      const status = statuses.shift();
      if (!status) return jsonResponse({ status: 'wait' });
      return jsonResponse(status);
    }
    return unexpected(call);
  });
  return {
    calls,
    qrRequests: () => callsTo(calls, '/ilink/bot/get_bot_qrcode'),
    statusRequests: () => callsTo(calls, '/ilink/bot/get_qrcode_status'),
  };
}

async function makeProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weixin-login-test-'));
  cleanupDirs.push(dir);
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function loginOptions(profileDir: string, onQr: (info: WeixinQrInfo) => void) {
  return {
    profileDir,
    onQr,
    readVerifyCode: async (): Promise<string | undefined> => undefined,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  };
}

describe('loginWeixinAccount', () => {
  it('returns credentials on confirmed and renders the QR once', async () => {
    const profileDir = await makeProfileDir();
    const server = installLoginServer({
      statuses: [
        {
          status: 'confirmed',
          bot_token: 'bot-token-1',
          ilink_bot_id: 'bot@im.test',
          baseurl: BASE_URL,
          ilink_user_id: 'user@im.test',
        },
      ],
    });
    const onQr = vi.fn<(info: WeixinQrInfo) => void>();

    const result = await loginWeixinAccount({ ...loginOptions(profileDir, onQr) });

    expect(result).toEqual({
      accountId: 'bot@im.test',
      token: 'bot-token-1',
      baseUrl: BASE_URL,
      userId: 'user@im.test',
    });
    expect(onQr).toHaveBeenCalledTimes(1);
    const qrInfo = onQr.mock.calls[0]?.[0];
    expect(qrInfo?.content).toBe('https://weixin.qq.com/x?q=qr-1');
    expect(qrInfo?.ascii.length).toBeGreaterThan(0);

    const qrRequest = server.qrRequests()[0];
    expect(qrRequest?.method).toBe('POST');
    expect(qrRequest?.url.searchParams.get('bot_type')).toBe(DEFAULT_ILINK_BOT_TYPE);
    expect(bodyOf<{ local_token_list: string[] }>(qrRequest).local_token_list).toEqual([]);

    const statusRequest = server.statusRequests()[0];
    expect(statusRequest?.method).toBe('GET');
    expect(statusRequest?.url.searchParams.get('qrcode')).toBe('qr-1');
    expect(statusRequest?.url.searchParams.get('verify_code')).toBeNull();
  });

  it('refreshes an expired QR and succeeds on the next code', async () => {
    const profileDir = await makeProfileDir();
    const server = installLoginServer({
      statuses: [
        { status: 'expired' },
        {
          status: 'confirmed',
          bot_token: 'bot-token-2',
          ilink_bot_id: 'bot2@im.test',
          baseurl: 'https://ilinkai.weixin.qq.com',
        },
      ],
    });
    const onQr = vi.fn<(info: WeixinQrInfo) => void>();

    const result = await loginWeixinAccount(loginOptions(profileDir, onQr));

    expect(result.token).toBe('bot-token-2');
    expect(server.qrRequests()).toHaveLength(2);
    expect(onQr).toHaveBeenCalledTimes(2);
    expect(onQr.mock.calls[1]?.[0].content).toBe('https://weixin.qq.com/x?q=qr-2');
  });

  it('gives up after the maximum number of QR refreshes', async () => {
    const profileDir = await makeProfileDir();
    const server = installLoginServer({
      statuses: [
        { status: 'expired' },
        { status: 'expired' },
        { status: 'expired' },
        { status: 'expired' },
      ],
    });

    await expect(
      loginWeixinAccount(loginOptions(profileDir, vi.fn())),
    ).rejects.toBeInstanceOf(WeixinLoginError);
    // One initial QR + three refreshes (the fourth expiry aborts).
    expect(server.qrRequests()).toHaveLength(4);
  });

  it('reports binded_redirect as already connected', async () => {
    const profileDir = await makeProfileDir();
    installLoginServer({
      statuses: [
        {
          status: 'binded_redirect',
          ilink_bot_id: 'bot@im.test',
          ilink_user_id: 'user@im.test',
        },
      ],
    });

    const error = await loginWeixinAccount(loginOptions(profileDir, vi.fn())).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(WeixinAlreadyConnectedError);
    expect((error as WeixinAlreadyConnectedError).alreadyConnected).toBe(true);
    expect((error as WeixinAlreadyConnectedError).userId).toBe('user@im.test');
  });

  it('submits a verification code and keeps polling', async () => {
    const profileDir = await makeProfileDir();
    const server = installLoginServer({
      statuses: [
        { status: 'need_verifycode' },
        {
          status: 'confirmed',
          bot_token: 'bot-token-3',
          ilink_bot_id: 'bot3@im.test',
          ilink_user_id: 'user3@im.test',
        },
      ],
    });
    const onQr = vi.fn<(info: WeixinQrInfo) => void>();
    const readVerifyCode = vi.fn(async () => '123456');

    const result = await loginWeixinAccount({
      ...loginOptions(profileDir, onQr),
      readVerifyCode,
    });

    expect(readVerifyCode).toHaveBeenCalledTimes(1);
    expect(result.accountId).toBe('bot3@im.test');
    const statusRequests = server.statusRequests();
    expect(statusRequests[0]?.url.searchParams.get('verify_code')).toBeNull();
    expect(statusRequests[1]?.url.searchParams.get('verify_code')).toBe('123456');
    expect(onQr).toHaveBeenCalledTimes(1);
  });

  it('follows a scaned_but_redirect IDC host change', async () => {
    const profileDir = await makeProfileDir();
    const seenHosts: string[] = [];
    const { calls } = installFetchMock((call): FetchReply => {
      if (call.url.pathname === '/ilink/bot/get_bot_qrcode') {
        return jsonResponse({ qrcode: 'qr-r', qrcode_img_content: 'https://weixin.qq.com/r' });
      }
      seenHosts.push(call.url.host);
      if (seenHosts.length === 1) {
        return jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'ilinkai.example.com' });
      }
      return jsonResponse({
        status: 'confirmed',
        bot_token: 'bot-token-4',
        ilink_bot_id: 'bot4@im.test',
      });
    });

    const result = await loginWeixinAccount(loginOptions(profileDir, vi.fn()));
    expect(result.accountId).toBe('bot4@im.test');
    expect(callsTo(calls, '/ilink/bot/get_qrcode_status')).toHaveLength(2);
    expect(seenHosts).toEqual(['ilinkai.weixin.qq.com', 'ilinkai.example.com']);
  });
});

// ---------------------------------------------------------------------------
// credential store
// ---------------------------------------------------------------------------

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

describe('weixin credential store', () => {
  it('sanitizes account ids into filesystem-safe names', () => {
    expect(safeWeixinAccountId('4f0d9c1e@im.test')).toBe('4f0d9c1e-im.test');
    expect(safeWeixinAccountId(' a/b c ')).toBe('a-b-c');
    expect(() => safeWeixinAccountId('   ')).toThrow();
  });

  it('round-trips an account with 0600 permissions and a token-free index', async () => {
    const profileDir = await makeProfileDir();
    const account = sampleAccount();

    const saved = await saveWeixinAccount(profileDir, account);
    expect(saved).toEqual(account);

    const credentialPath = join(
      profileDir,
      'weixin',
      'accounts',
      `${safeWeixinAccountId(account.id)}.json`,
    );
    const fileMode = (await stat(credentialPath)).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const loaded = await loadWeixinAccount(profileDir, account.id);
    expect(loaded).toEqual(account);

    const index = JSON.parse(
      await readFile(join(profileDir, 'weixin', 'index.json'), 'utf8'),
    ) as { version: number; accounts: string[] };
    expect(index.version).toBe(1);
    expect(index.accounts).toEqual([account.id]);
    expect(JSON.stringify(index)).not.toContain(account.token);
  });

  it('lists accounts in login order and skips nothing after a re-save', async () => {
    const profileDir = await makeProfileDir();
    const first = sampleAccount({ id: 'first@im.test', token: 'token-first' });
    const second = sampleAccount({ id: 'second@im.test', token: 'token-second' });

    await saveWeixinAccount(profileDir, first);
    await saveWeixinAccount(profileDir, second);
    await saveWeixinAccount(profileDir, { ...first, name: 'renamed' });

    const listed = await listWeixinAccounts(profileDir);
    expect(listed.map((entry) => entry.id)).toEqual(['first@im.test', 'second@im.test']);
    expect(listed[0]?.name).toBe('renamed');
    expect(listed[1]?.token).toBe('token-second');

    await clearWeixinAccount(profileDir, first.id);
    expect(await loadWeixinAccount(profileDir, first.id)).toBeUndefined();
    expect((await listWeixinAccounts(profileDir)).map((entry) => entry.id)).toEqual([
      'second@im.test',
    ]);

    // Clearing twice is a no-op.
    await clearWeixinAccount(profileDir, first.id);
    expect(await listWeixinAccounts(profileDir)).toHaveLength(1);
  });

  it('returns undefined for an account that was never saved', async () => {
    const profileDir = await makeProfileDir();
    expect(await loadWeixinAccount(profileDir, 'missing@im.test')).toBeUndefined();
    expect(await listWeixinAccounts(profileDir)).toEqual([]);
  });

  it('rejects accounts without a token', async () => {
    const profileDir = await makeProfileDir();
    await expect(saveWeixinAccount(profileDir, sampleAccount({ token: '  ' }))).rejects.toThrow(
      /token/,
    );
  });
});
