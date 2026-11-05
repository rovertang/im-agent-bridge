import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WeixinAccount,
  WeixinInboundMessage,
  WeixinTransportOptions,
} from '../../../src/channel/weixin';
import { saveWeixinAccount, startWeixinTransport } from '../../../src/channel/weixin';
import type { ChannelPort } from '../../../src/channel/port';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { checkRuntimeLock } from '../../../src/runtime/locks';
import {
  liveEntriesForProfile,
  readAndPrune,
} from '../../../src/runtime/registry';
import { resolveProfileRuntime } from '../../../src/runtime/profile-runtime';
import type { WeixinRunner } from '../../../src/runtime/weixin-runner';
import { startWeixinProfile } from '../../../src/runtime/weixin-profile';

const roots: string[] = [];
const originalChannelEnv = process.env.LARK_CHANNEL_CHANNEL;

afterEach(async () => {
  vi.clearAllMocks();
  if (originalChannelEnv === undefined) delete process.env.LARK_CHANNEL_CHANNEL;
  else process.env.LARK_CHANNEL_CHANNEL = originalChannelEnv;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-weixin-start-'));
  roots.push(root);
  return root;
}

const account: WeixinAccount = {
  id: '4f0d@im.test',
  token: 'test-token',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  userId: 'owner-1',
  name: 'WeChat Bot',
  loggedInAt: new Date().toISOString(),
};

async function makeWeixinRuntime(root: string) {
  const configPath = join(root, 'config.json');
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    channel: { kind: 'weixin' },
    weixin: { accounts: [{ id: account.id, name: account.name }], ownerId: account.userId },
  });
  await saveRootConfig(createRootConfig('wx', profileConfig), configPath);
  await mkdir(join(root, 'profiles', 'wx'), { recursive: true });
  await saveWeixinAccount(join(root, 'profiles', 'wx'), account);
  return resolveProfileRuntime({ config: configPath, profile: 'wx', allowBootstrap: false });
}

describe('startWeixinProfile', () => {
  it('acquires channel-scoped locks, registers a weixin entry, starts/stops the transport', async () => {
    const root = await tmpRoot();
    const runtime = await makeWeixinRuntime(root);
    const order: string[] = [];
    const transport = {
      account,
      port: { kind: 'weixin' } as ChannelPort,
      stop: vi.fn(async () => {
        order.push('transport');
      }),
    };
    const fakeRunner = {
      handleInbound: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        order.push('runner');
      }),
    } as unknown as WeixinRunner;
    let capturedOnMessage: WeixinTransportOptions['onMessage'];
    const startTransport = vi.fn(async (opts: WeixinTransportOptions) => {
      capturedOnMessage = opts.onMessage;
      return transport;
    }) as unknown as typeof startWeixinTransport;

    const handle = await startWeixinProfile(runtime, {
      startTransport,
      ensureAgentAvailable: async () => undefined,
      createRunner: () => fakeRunner,
    });

    expect(startTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        profileDir: runtime.appPaths.profileDir,
        onMessage: expect.any(Function),
      }),
    );
    expect(process.env.LARK_CHANNEL_CHANNEL).toBe('weixin');
    expect(handle.account.id).toBe(account.id);

    // Inbound DMs are handed to the session runner by the transport closure.
    const inbound: WeixinInboundMessage = {
      message: { message_id: '1', from_user_id: 'owner-1', message_type: 1 },
      peer: 'owner-1',
      receivedAt: Date.now(),
    };
    await capturedOnMessage?.(inbound);
    expect(fakeRunner.handleInbound).toHaveBeenCalledWith(inbound);

    // Registry entry is a weixin entry keyed by account id, with a bot name.
    const entries = readAndPrune(runtime.appPaths.userRegistryFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      appId: account.id,
      tenant: 'weixin',
      channel: 'weixin',
      profileName: 'wx',
      botName: account.name,
    });
    // The entry is provably live through its channel-scoped app lock.
    await expect(liveEntriesForProfile('wx', runtime.appPaths.userRegistryFile)).resolves.toHaveLength(1);

    const profileLock = await checkRuntimeLock(runtime.appPaths.profileLockFile);
    const appLock = await checkRuntimeLock(
      runtime.appPaths.appLockFile(`weixin:${account.id}`),
    );
    expect(profileLock.locked).toBe(true);
    expect(appLock.locked).toBe(true);

    await handle.stop();

    // Shutdown order: stop the runner before the transport.
    expect(order).toEqual(['runner', 'transport']);
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(readAndPrune(runtime.appPaths.userRegistryFile)).toHaveLength(0);
    await expect(
      checkRuntimeLock(runtime.appPaths.profileLockFile),
    ).resolves.toEqual({ locked: false });
    await expect(
      checkRuntimeLock(runtime.appPaths.appLockFile(`weixin:${account.id}`)),
    ).resolves.toEqual({ locked: false });
  });

  it('fails with the login hint when the profile has no account yet', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    await saveRootConfig(
      createRootConfig(
        'wx',
        createDefaultProfileConfig({
          agentKind: 'claude',
          channel: { kind: 'weixin' },
          weixin: { accounts: [] },
        }),
      ),
      configPath,
    );
    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'wx',
      allowBootstrap: false,
    });

    await expect(
      startWeixinProfile(runtime, { ensureAgentAvailable: async () => undefined }),
    ).rejects.toThrow(/weixin login --profile wx/);
  });

  it('fails when the local credential file is missing', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    await saveRootConfig(
      createRootConfig(
        'wx',
        createDefaultProfileConfig({
          agentKind: 'claude',
          channel: { kind: 'weixin' },
          weixin: { accounts: [{ id: account.id }] },
        }),
      ),
      configPath,
    );
    await mkdir(join(root, 'profiles', 'wx'), { recursive: true });
    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'wx',
      allowBootstrap: false,
    });

    await expect(
      startWeixinProfile(runtime, { ensureAgentAvailable: async () => undefined }),
    ).rejects.toThrow(/本地凭证/);
  });

  it('rolls back registration and locks when the transport fails to start', async () => {
    const root = await tmpRoot();
    const runtime = await makeWeixinRuntime(root);
    const startTransport = vi.fn(async () => {
      throw new Error('notifyStart failed');
    }) as unknown as typeof import('../../../src/channel/weixin').startWeixinTransport;

    await expect(
      startWeixinProfile(runtime, {
        startTransport,
        ensureAgentAvailable: async () => undefined,
      }),
    ).rejects.toThrow(/notifyStart failed/);

    expect(readAndPrune(runtime.appPaths.userRegistryFile)).toHaveLength(0);
    await expect(
      checkRuntimeLock(runtime.appPaths.profileLockFile),
    ).resolves.toEqual({ locked: false });
    await expect(
      checkRuntimeLock(runtime.appPaths.appLockFile(`weixin:${account.id}`)),
    ).resolves.toEqual({ locked: false });
  });
});
