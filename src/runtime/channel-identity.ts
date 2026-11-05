import type { AppPaths } from '../config/app-paths';
import {
  profileChannelKind,
  type ProfileChannelKind,
  type ProfileConfig,
  type WeixinProfileAccountConfig,
} from '../config/profile-schema';

/**
 * Prefix that keeps a WeChat account's app lock in a different namespace than
 * any Lark app id. The lock file name is sanitized by `AppPaths.appLockFile`,
 * so `weixin:4f0d…@im.bot` never reaches the filesystem verbatim.
 */
export const WEIXIN_APP_LOCK_PREFIX = 'weixin:';

/** First logged-in WeChat account of a weixin profile, if any. */
export function weixinPrimaryAccount(
  profileConfig: ProfileConfig,
): WeixinProfileAccountConfig | undefined {
  if (profileChannelKind(profileConfig) !== 'weixin') return undefined;
  return profileConfig.weixin?.accounts[0];
}

/**
 * Identity used for the app-level runtime lock: the Lark app id for lark
 * profiles, `weixin:<accountId>` for weixin profiles (channel-scoped so a Lark
 * app and a WeChat account can never collide).
 */
export function appLockIdForProfile(profileConfig: ProfileConfig): string | undefined {
  if (profileChannelKind(profileConfig) === 'weixin') {
    const accountId = weixinPrimaryAccount(profileConfig)?.id;
    return accountId ? `${WEIXIN_APP_LOCK_PREFIX}${accountId}` : undefined;
  }
  return profileConfig.accounts?.app.id;
}

/** App lock target file for a profile, or undefined when it has no identity yet. */
export function appLockTargetForProfile(
  appPaths: Pick<AppPaths, 'appLockFile'>,
  profileConfig: ProfileConfig,
): string | undefined {
  const lockId = appLockIdForProfile(profileConfig);
  return lockId ? appPaths.appLockFile(lockId) : undefined;
}

/**
 * Registry `appId` column. A weixin entry stores the bare account id (like
 * `ps` shows for bots), while its lock target carries the channel prefix above.
 */
export function registryAppIdForProfile(profileConfig: ProfileConfig): string | undefined {
  if (profileChannelKind(profileConfig) === 'weixin') {
    return weixinPrimaryAccount(profileConfig)?.id;
  }
  return profileConfig.accounts?.app.id;
}

/**
 * Reverse of {@link appLockIdForProfile} for a registry entry: entries written
 * before the channel field existed are lark by definition.
 */
export function appLockIdForChannel(
  channel: ProfileChannelKind | undefined,
  appId: string,
): string {
  return channel === 'weixin' ? `${WEIXIN_APP_LOCK_PREFIX}${appId}` : appId;
}
