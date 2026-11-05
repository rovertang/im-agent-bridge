import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { DshAdapter } from '../agent/dsh/adapter';
import { DEFAULT_DSH_PROVIDER } from '../agent/dsh/patches';
import { AgentPreflightError, type AgentAvailability, type LocalAgentId } from '../agent/preflight';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import {
  profileChannelKind,
  type AgentKind,
  type ProfileConfig,
} from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  // The injected env tells lark-cli to enter bridge-bound mode for *this*
  // profile. A weixin profile has no lark-cli projection, so pointing the agent
  // at one would make any `lark-cli` call fail or pick the wrong workspace.
  const larkChannel =
    profileChannelKind(profileConfig) === 'lark' && appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  if (profileConfig.agentKind === 'dsh') {
    const dsh = profileConfig.dsh;
    if (!dsh?.binaryPath) {
      throw new Error('dsh profile requires dsh.binaryPath');
    }
    return new DshAdapter({
      binary: dsh.binaryPath,
      profileStateDir: appPaths.profileDir,
      provider: dsh.provider ?? DEFAULT_DSH_PROVIDER,
      ...(dsh.profile ? { profile: dsh.profile } : {}),
      ...(dsh.patches ? { patches: dsh.patches } : {}),
      ...(dsh.dshHome ? { dshHome: dsh.dshHome } : {}),
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  return new ClaudeAdapter({ larkChannel });
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const agentId: LocalAgentId = agent.id === 'codex' || agent.id === 'dsh' ? agent.id : 'claude';
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId,
    agentName: agent.displayName,
    command: agentId,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
