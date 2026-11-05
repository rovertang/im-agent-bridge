import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  WEIXIN_APP_LOCK_PREFIX,
  appLockIdForChannel,
  appLockIdForProfile,
  appLockTargetForProfile,
  registryAppIdForProfile,
  weixinPrimaryAccount,
} from '../../../src/runtime/channel-identity';

const larkProfile = createDefaultProfileConfig({
  agentKind: 'claude',
  accounts: { app: { id: 'cli_lark', secret: '${APP_SECRET}', tenant: 'feishu' } },
});

function weixinProfile(accounts: Array<{ id: string }> = [{ id: '4f0d@im.test' }]) {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    channel: { kind: 'weixin' },
    weixin: { accounts },
  });
}

describe('channel identity helpers', () => {
  it('locks and registers lark profiles by app id', () => {
    expect(appLockIdForProfile(larkProfile)).toBe('cli_lark');
    expect(registryAppIdForProfile(larkProfile)).toBe('cli_lark');
    expect(appLockIdForChannel(undefined, 'cli_lark')).toBe('cli_lark');
  });

  it('locks weixin profiles by a channel-scoped account id but registers the bare account id', () => {
    const wx = weixinProfile();
    expect(weixinPrimaryAccount(wx)?.id).toBe('4f0d@im.test');
    expect(appLockIdForProfile(wx)).toBe(`${WEIXIN_APP_LOCK_PREFIX}4f0d@im.test`);
    expect(registryAppIdForProfile(wx)).toBe('4f0d@im.test');
    expect(appLockIdForChannel('weixin', '4f0d@im.test')).toBe(
      `${WEIXIN_APP_LOCK_PREFIX}4f0d@im.test`,
    );
  });

  it('never puts the raw Arroba account id into a lock file name', () => {
    const appPaths = resolveAppPaths({ rootDir: '/tmp/bridge-channel-identity', profile: 'wx' });
    const target = appLockTargetForProfile(appPaths, weixinProfile());
    expect(target).toBeDefined();
    expect(target).not.toContain('@');
    expect(target?.endsWith('.lock')).toBe(true);
  });

  it('returns no identity before a weixin account has logged in', () => {
    const wx = weixinProfile([]);
    expect(weixinPrimaryAccount(wx)).toBeUndefined();
    expect(appLockIdForProfile(wx)).toBeUndefined();
    expect(registryAppIdForProfile(wx)).toBeUndefined();
    expect(appLockTargetForProfile(resolveAppPaths({ rootDir: '/tmp/x' }), wx)).toBeUndefined();
  });
});
