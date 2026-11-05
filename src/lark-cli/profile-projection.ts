import { chmod, mkdir } from 'node:fs/promises';
import type { AppPaths } from '../config/app-paths';
import type { AppConfig, ProviderConfig, SecretRef, SecretsConfig } from '../config/schema';
import { isSecretRef } from '../config/schema';
import { ensureSecretsGetterWrapper } from '../config/store';
import { writeFileAtomic } from '../platform/atomic-write';

export async function writeLarkCliSourceProjection(
  cfg: AppConfig,
  appPaths: Pick<
    AppPaths,
    | 'rootDir'
    | 'profile'
    | 'larkCliSourceDir'
    | 'larkCliSourceConfigFile'
    | 'secretsGetterScript'
  >,
): Promise<string> {
  // Only lark profiles have app credentials to project; callers must gate on
  // the channel kind first (weixin profiles never run lark-cli).
  const app = cfg.accounts?.app;
  if (!app) {
    throw new Error('lark-cli source projection requires a lark profile with accounts.app');
  }
  await mkdir(appPaths.larkCliSourceDir, { recursive: true, mode: 0o700 });
  await chmod(appPaths.larkCliSourceDir, 0o700).catch(() => {});

  const secrets = await buildProjectionSecrets(cfg, appPaths);
  const projection = {
    accounts: {
      app: {
        id: app.id,
        secret: app.secret,
        tenant: app.tenant,
      },
    },
    ...(secrets ? { secrets } : {}),
  };

  await writeFileAtomic(appPaths.larkCliSourceConfigFile, `${JSON.stringify(projection, null, 2)}\n`, {
    mode: 0o600,
  });
  return appPaths.larkCliSourceConfigFile;
}

async function buildProjectionSecrets(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'rootDir' | 'profile' | 'secretsGetterScript'>,
): Promise<SecretsConfig | undefined> {
  const providers: Record<string, ProviderConfig> = {
    ...(cfg.secrets?.providers ?? {}),
  };
  const providerName = bridgeProviderName(cfg.accounts.app.secret);
  if (providerName) {
    const wrapperPath = await ensureSecretsGetterWrapper(appPaths);
    const existing = providers[providerName];
    providers[providerName] = {
      ...(existing ?? {}),
      source: 'exec',
      command: wrapperPath,
      args: [],
      env: {
        ...(existing?.env ?? {}),
        LARK_CHANNEL_HOME: appPaths.rootDir,
        LARK_CHANNEL_PROFILE: appPaths.profile,
      },
    };
  }

  if (Object.keys(providers).length === 0 && !cfg.secrets?.defaults) return undefined;
  return {
    ...(cfg.secrets?.defaults ? { defaults: cfg.secrets.defaults } : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
}

function bridgeProviderName(secret: AppConfig['accounts']['app']['secret']): string | undefined {
  if (!isSecretRef(secret)) return undefined;
  if (secret.source !== 'exec') return undefined;
  const ref = secret as SecretRef;
  return ref.provider ?? 'default';
}
