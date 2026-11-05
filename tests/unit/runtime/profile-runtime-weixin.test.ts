import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, profileChannelKind } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import {
  requireLarkRuntimeCfg,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'should-not-run' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-weixin-runtime-'));
  roots.push(root);
  return root;
}

describe('weixin profile runtime', () => {
  it('bootstraps a weixin profile without any Feishu app bootstrap', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');

    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'wx',
      agent: 'claude',
      channel: 'weixin',
      allowBootstrap: true,
    });

    expect(runtime.cfg).toBeUndefined();
    expect(runtime.profile).toBe('wx');
    expect(profileChannelKind(runtime.profileConfig)).toBe('weixin');
    expect(runtime.profileConfig.channel).toEqual({ kind: 'weixin' });
    expect(runtime.profileConfig.weixin).toEqual({ accounts: [] });
    expect(runtime.profileConfig.accounts).toBeUndefined();
    expect(auth.validateAppCredentials).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('wx\n');

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { channel?: unknown; accounts?: unknown; weixin?: unknown }>;
    };
    expect(saved.profiles.wx?.channel).toEqual({ kind: 'weixin' });
    expect(saved.profiles.wx?.weixin).toEqual({ accounts: [] });
    expect(saved.profiles.wx).not.toHaveProperty('accounts');
  });

  it('resolves an existing weixin profile without constructing lark cfg or requiring accounts', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'claude',
      channel: { kind: 'weixin' },
      weixin: { accounts: [{ id: 'acct@im.test' }], ownerId: 'owner-1' },
    });
    await saveRootConfig(createRootConfig('wx', profileConfig), configPath);

    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'wx',
      allowBootstrap: false,
    });

    expect(runtime.cfg).toBeUndefined();
    expect(runtime.profileConfig.weixin?.accounts.map((account) => account.id)).toEqual([
      'acct@im.test',
    ]);
    expect(() => requireLarkRuntimeCfg(runtime)).toThrow(/微信渠道/);
    expect(auth.validateAppCredentials).not.toHaveBeenCalled();
  });

  it('adds a weixin profile into an existing root config without touching sibling lark profiles', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const larkProfile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_lark', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    await saveRootConfig(createRootConfig('claude', larkProfile), configPath);

    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'wx',
      agent: 'claude',
      channel: 'weixin',
      allowBootstrap: true,
    });

    expect(runtime.profileConfig.accounts).toBeUndefined();
    expect(runtime.profileConfig.weixin).toEqual({ accounts: [] });
    const loaded = await loadRootConfig(configPath);
    expect(loaded?.activeProfile).toBe('claude');
    expect(loaded?.profiles.claude?.accounts?.app.id).toBe('cli_lark');
    expect(profileChannelKind(loaded!.profiles.wx!)).toBe('weixin');
  });

  it('defaults to lark when no channel is requested', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_default', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    await saveRootConfig(createRootConfig('claude', profileConfig), configPath);

    const runtime = await resolveProfileRuntime({
      config: configPath,
      profile: 'claude',
      allowBootstrap: false,
    });

    expect(runtime.cfg?.accounts.app.id).toBe('cli_default');
    expect(profileChannelKind(runtime.profileConfig)).toBe('lark');
    expect(runtime.appPaths.rootDir).toBe(root);
    expect(runtime.appPaths.profile).toBe('claude');
  });
});
