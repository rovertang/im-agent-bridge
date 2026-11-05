import pkg from '../../package.json';
import {
  loadWeixinAccount,
  startWeixinTransport,
  type WeixinAccount,
  type WeixinChannelPort,
} from '../channel/weixin';
import { profileChannelKind, type ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import {
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  releaseRuntimeLocks,
} from './agent-runtime';
import { appLockIdForProfile, weixinPrimaryAccount } from './channel-identity';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import type { ProfileRuntime } from './profile-runtime';
import { register, unregister, updateEntry, type ProcessEntry } from './registry';
import { createWeixinRunner, type WeixinRunner } from './weixin-runner';

export interface WeixinProfileHandle {
  account: WeixinAccount;
  entryId: string;
  /** Stop the transport, unregister this process and release its locks. */
  stop(): Promise<void>;
}

export interface StartWeixinProfileDeps {
  /** Injectable transport factory (tests use a fake). */
  startTransport?: typeof startWeixinTransport;
  /** Injectable agent availability check (tests use a no-op). */
  ensureAgentAvailable?: (runtime: ProfileRuntime) => Promise<void>;
  /** Injectable runner factory (tests use a fake port/agent). */
  createRunner?: (args: {
    runtime: ProfileRuntime;
    account: WeixinAccount;
    port: WeixinChannelPort;
  }) => WeixinRunner;
}

/**
 * Bring a `weixin` profile online for the single-profile `run` path.
 *
 * Resolve the logged-in account, take the profile + channel-scoped app locks,
 * register, start the transport and hand inbound DMs to the session runner;
 * the caller owns the process-signal lifecycle.
 */
export async function startWeixinProfile(
  runtime: ProfileRuntime,
  deps: StartWeixinProfileDeps = {},
): Promise<WeixinProfileHandle> {
  const profileConfig = runtime.profileConfig;
  if (profileChannelKind(profileConfig) !== 'weixin') {
    throw new Error(`profile「${runtime.profile}」不是微信渠道`);
  }
  const accountConfig = weixinPrimaryAccount(profileConfig);
  if (!accountConfig) {
    throw new Error(
      `profile「${runtime.profile}」还没有登录微信账号：` +
        `请先运行 \`lark-channel-bridge weixin login --profile ${runtime.profile}\`。`,
    );
  }
  const account = await loadWeixinAccount(runtime.appPaths.profileDir, accountConfig.id);
  if (!account) {
    throw new Error(
      `找不到微信账号 ${accountConfig.id} 的本地凭证：` +
        `请重新运行 \`lark-channel-bridge weixin login --profile ${runtime.profile}\`。`,
    );
  }

  // Agents build their system prompt at spawn time; tell them this is the
  // WeChat channel before the first adapter is constructed (single-profile run).
  process.env.LARK_CHANNEL_CHANNEL = 'weixin';

  const ensureAgentAvailable =
    deps.ensureAgentAvailable ??
    (async (current: ProfileRuntime): Promise<void> => {
      const agent = createRuntimeAgent(profileConfig, {
        ...current.appPaths,
        configPath: current.configPath,
      });
      const availability = await checkRuntimeAgentAvailability(agent);
      if (!availability.ok) throw availability.error;
    });
  await ensureAgentAvailable(runtime);

  const locks: AcquiredRuntimeLock[] = [];
  let entry: ProcessEntry | undefined;
  let transport: Awaited<ReturnType<typeof startWeixinTransport>> | undefined;
  let runner: WeixinRunner | undefined;
  try {
    locks.push(await acquireProfileRuntimeLock(runtime.appPaths, profileConfig.agentKind));
    const lockId = appLockIdForProfile(profileConfig);
    if (!lockId) throw new Error('weixin profile has no account id for the app runtime lock');
    locks.push(await acquireAppRuntimeLock(runtime.appPaths, lockId, profileConfig.agentKind));
    entry = await register({
      appId: account.id,
      tenant: 'weixin',
      channel: 'weixin',
      profileName: runtime.profile,
      agentKind: profileConfig.agentKind,
      configPath: runtime.configPath,
      version: pkg.version,
      registryFile: runtime.appPaths.userRegistryFile,
    });
    // The transport polls for inbound DMs; the runner is created right after it
    // comes online so it can use the transport's port (shared typing ticket cache).
    let pendingRunner: WeixinRunner | undefined;
    transport = await (deps.startTransport ?? startWeixinTransport)({
      account,
      profileDir: runtime.appPaths.profileDir,
      onStatus: (status, detail) => {
        // A dead bot token is the one status that needs the operator: the poll
        // loop exits and nothing else would tell them why the bot went quiet.
        if (status === 'token-expired') {
          log.warn('weixin', 'transport-token-expired', {
            profile: runtime.profile,
            ...(detail ? { detail } : {}),
            hint: '请重新运行 `lark-channel-bridge weixin login` 后重启',
          });
        }
      },
      onMessage: (message) => pendingRunner?.handleInbound(message) ?? Promise.resolve(),
    });
    pendingRunner = deps.createRunner
      ? deps.createRunner({ runtime, account, port: transport.port })
      : createWeixinRunner({ runtime, account, port: transport.port });
    // `done` resolves (it never rejects) when the poll loop exits; a fatal
    // token expiry is carried on `error` rather than as a rejection. Real
    // transports expose both, test fakes may not, hence the optional chaining.
    const reportTransportStopped = (err?: unknown): void => {
      const fatal = err ?? (transport as { error?: Error } | undefined)?.error;
      if (!fatal) return;
      log.warn('weixin', 'transport-stopped', {
        profile: runtime.profile,
        err: fatal instanceof Error ? fatal.message : String(fatal),
        hint: '请重新运行 `lark-channel-bridge weixin login` 后重启',
      });
    };
    void (transport as { done?: Promise<unknown> }).done?.then(
      () => reportTransportStopped(),
      (err: unknown) => reportTransportStopped(err),
    );
    runner = pendingRunner;
    // Surface the account in `ps`/`status`; a weixin transport has no bot name
    // handshake, so fall back to the account id.
    await updateEntry(
      entry.id,
      { botName: account.name ?? account.id },
      runtime.appPaths.userRegistryFile,
    ).catch((err) => log.warn('registry', 'update-failed', { step: 'weixin', err: String(err) }));
  } catch (err) {
    if (entry) {
      await unregister(entry.id, runtime.appPaths.userRegistryFile).catch(() => undefined);
    }
    if (runner) await runner.stop().catch(() => undefined);
    if (transport) await transport.stop().catch(() => undefined);
    await releaseRuntimeLocks(locks);
    throw err;
  }

  if (!entry) throw new Error('weixin profile registration failed');
  const registeredEntry = entry;
  let stopped = false;
  return {
    account,
    entryId: registeredEntry.id,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Runner first (stop queued work + interrupt the active run), then the
      // transport so no new inbound DM can race the shutdown.
      try {
        await runner?.stop();
      } catch (err) {
        log.warn('weixin', 'runner-stop-failed', {
          profile: runtime.profile,
          err: String(err),
        });
      }
      try {
        await transport?.stop();
      } catch (err) {
        log.warn('weixin', 'transport-stop-failed', {
          profile: runtime.profile,
          err: String(err),
        });
      }
      await unregister(registeredEntry.id, runtime.appPaths.userRegistryFile).catch(
        () => undefined,
      );
      await releaseRuntimeLocks(locks);
    },
  };
}

/**
 * Check that a weixin profile has a login + local credential for its first
 * account. Used by the startup preflight so `start` fails in the TTY with a
 * clear hint instead of a daemon that dies after launch.
 */
export async function requireWeixinAccountCredential(
  profileConfig: ProfileConfig,
  profileDir: string,
  profileName: string,
): Promise<WeixinAccount> {
  const accountConfig = weixinPrimaryAccount(profileConfig);
  if (!accountConfig) {
    throw new Error(
      `profile「${profileName}」还没有登录微信账号：` +
        `请先运行 \`lark-channel-bridge weixin login --profile ${profileName}\`。`,
    );
  }
  const account = await loadWeixinAccount(profileDir, accountConfig.id);
  if (!account) {
    throw new Error(
      `找不到微信账号 ${accountConfig.id} 的本地凭证（${profileDir}/weixin/）：` +
        `请重新运行 \`lark-channel-bridge weixin login --profile ${profileName}\`。`,
    );
  }
  return account;
}
