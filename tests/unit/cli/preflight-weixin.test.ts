import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const spawn = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
  spawnProcessSync: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', () => ({
  mergeProcessEnv: (base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv) => ({
    ...base,
    ...overrides,
  }),
  spawnProcess: spawn.spawnProcess,
  spawnProcessSync: spawn.spawnProcessSync,
}));

const { preFlightChecks } = await import('../../../src/cli/preflight');

afterEach(() => {
  spawn.spawnProcessSync.mockReset();
  spawn.spawnProcess.mockReset();
});

const weixinProfile = createDefaultProfileConfig({
  agentKind: 'claude',
  channel: { kind: 'weixin' },
  weixin: { accounts: [{ id: '4f0d@im.test' }] },
});

const appPaths = resolveAppPaths({ rootDir: join(tmpdir(), 'bridge-preflight-weixin'), profile: 'wx' });

describe('preflight for weixin profiles', () => {
  it('checks the weixin credential and agent binary without ever invoking lark-cli', async () => {
    const ensureCredential = vi.fn(async () => undefined);
    const ensureAgentAvailable = vi.fn(async () => undefined);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    try {
      await preFlightChecks({
        profileConfig: weixinProfile,
        appPaths,
        weixinDeps: { ensureCredential, ensureAgentAvailable },
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(ensureCredential).toHaveBeenCalledWith(weixinProfile, appPaths.profileDir, 'wx');
    expect(ensureAgentAvailable).toHaveBeenCalledWith(weixinProfile, appPaths);
    expect(spawn.spawnProcessSync).not.toHaveBeenCalled();
    expect(spawn.spawnProcess).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toMatch(/lark-cli/i);
  });

  it('surfaces a missing login instead of silently continuing', async () => {
    await expect(
      preFlightChecks({
        profileConfig: weixinProfile,
        appPaths,
        weixinDeps: {
          ensureCredential: async () => {
            throw new Error('profile「wx」还没有登录微信账号');
          },
          ensureAgentAvailable: async () => undefined,
        },
      }),
    ).rejects.toThrow(/还没有登录微信账号/);
  });

  it('still runs the lark-cli preflight for lark profiles', async () => {
    const larkProfile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_lark', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    spawn.spawnProcessSync.mockReturnValue({ status: 0 });
    spawn.spawnProcess.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      setImmediate(() => child.emit('exit', 0));
      return child;
    });
    await preFlightChecks({
      profileConfig: larkProfile,
      appPaths,
      skipCheckLarkCli: false,
    });
    // lark-cli --version is probed for lark profiles.
    expect(spawn.spawnProcessSync).toHaveBeenCalledTimes(1);
    expect(spawn.spawnProcess).toHaveBeenCalledWith(
      'lark-cli',
      ['config', 'show'],
      expect.anything(),
    );
  });
});
