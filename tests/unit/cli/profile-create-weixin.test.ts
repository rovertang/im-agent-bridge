import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileCreate } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { profileChannelKind } from '../../../src/config/profile-schema';
import { loadRootConfig } from '../../../src/config/profile-store';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const wizard = vi.hoisted(() => ({ runRegistrationWizard: vi.fn() }));
const auth = vi.hoisted(() => ({ validateAppCredentials: vi.fn() }));

vi.mock('../../../src/bot/wizard', () => ({
  runRegistrationWizard: wizard.runRegistrationWizard,
}));
vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-create-weixin-'));
  roots.push(root);
  return root;
}

describe('profile create --channel weixin', () => {
  it('creates a weixin profile without app credentials or the QR wizard', async () => {
    const root = await makeRoot();

    await runProfileCreate('wx', { rootDir: root, agent: 'claude', channel: 'weixin' });

    const loaded = await loadRootConfig(join(root, 'config.json'));
    const profile = loaded?.profiles.wx;
    expect(profile).toBeDefined();
    expect(profileChannelKind(profile!)).toBe('weixin');
    expect(profile?.channel).toEqual({ kind: 'weixin' });
    expect(profile?.weixin).toEqual({ accounts: [] });
    expect(profile?.accounts).toBeUndefined();
    expect(profile?.agentKind).toBe('claude');
    expect(wizard.runRegistrationWizard).not.toHaveBeenCalled();
    expect(auth.validateAppCredentials).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('wx\n');
    // A managed workspace is still provisioned for the agent to run in.
    const workspace = await realpath(resolveAppPaths({ rootDir: root, profile: 'wx' }).defaultWorkspaceDir);
    expect(profile?.workspaces.default).toBe(workspace);
  });

  it('supports --agent dsh for a weixin profile', async () => {
    const root = await makeRoot();
    const dsh = await writeVersionExecutable(root, 'dsh', 'dsh 1.0.0');
    const previous = process.env.LARK_CHANNEL_DSH_BIN;
    process.env.LARK_CHANNEL_DSH_BIN = dsh;
    try {
      await runProfileCreate('wx-dsh', { rootDir: root, agent: 'dsh', channel: 'weixin' });
    } finally {
      if (previous === undefined) delete process.env.LARK_CHANNEL_DSH_BIN;
      else process.env.LARK_CHANNEL_DSH_BIN = previous;
    }

    const loaded = await loadRootConfig(join(root, 'config.json'));
    const profile = loaded?.profiles['wx-dsh'];
    expect(profileChannelKind(profile!)).toBe('weixin');
    expect(profile?.accounts).toBeUndefined();
    expect(profile?.agentKind).toBe('dsh');
    expect(profile?.dsh?.binaryPath).toBe(await realpath(dsh));
  });

  it('rejects an unknown --channel value before touching config', async () => {
    const root = await makeRoot();
    await expect(
      runProfileCreate('wx', { rootDir: root, agent: 'claude', channel: 'telegram' }),
    ).rejects.toThrow(/channel must be lark or weixin/);
    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps the lark default unchanged when --channel is omitted', async () => {
    const root = await makeRoot();
    auth.validateAppCredentials.mockResolvedValue({ ok: true, botName: 'Lark Bot' });
    await runProfileCreate('lark', {
      rootDir: root,
      agent: 'claude',
      appId: 'cli_lark',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const loaded = await loadRootConfig(join(root, 'config.json'));
    const profile = loaded?.profiles.lark;
    expect(profileChannelKind(profile!)).toBe('lark');
    expect(profile?.channel).toBeUndefined();
    expect(profile?.accounts?.app.id).toBe('cli_lark');
    expect(auth.validateAppCredentials).toHaveBeenCalledWith('cli_lark', 'manual-secret', 'feishu');
  });
});
