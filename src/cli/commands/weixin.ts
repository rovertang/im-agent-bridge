import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createWeixinChannelPort,
  loadWeixinAccount,
  loginWeixinAccount,
  saveWeixinAccount,
  DEFAULT_WEIXIN_BASE_URL,
  type WeixinAccount,
} from '../../channel/weixin';
import { profileChannelKind, type ProfileConfig } from '../../config/profile-schema';
import { loadRootConfig, saveRootConfig } from '../../config/profile-store';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';

export interface WeixinLoginOptions {
  config?: string;
  profile?: string;
}

function requireWeixinProfile(profileConfig: ProfileConfig, profile: string): void {
  if (profileChannelKind(profileConfig) !== 'weixin') {
    throw new Error(
      `profile 「${profile}」不是微信渠道：请用 --channel weixin 创建，或先切换 profile。`,
    );
  }
}

async function readLine(prompt: string): Promise<string | undefined> {
  if (!input.isTTY) return undefined;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

/**
 * `weixin login`: scan-to-connect flow for a weixin profile.
 *
 * Mirrors the official openclaw-weixin login UX (terminal QR + optional SMS
 * verification code) but writes credentials into this profile's state dir, not
 * `~/.openclaw`. The bot token never touches config.json.
 */
export async function runWeixinLogin(opts: WeixinLoginOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    allowBootstrap: false,
  });
  requireWeixinProfile(runtime.profileConfig, runtime.profile);

  console.log(`\n微信扫码登录（profile: ${runtime.profile}）\n`);
  const result = await loginWeixinAccount({
    profileDir: runtime.appPaths.profileDir,
    onQr: (info) => {
      console.log(info.ascii);
      console.log('\n若二维码无法显示，可复制以下链接在手机微信中打开：');
      console.log(info.content);
      console.log('');
    },
    readVerifyCode: () =>
      readLine('手机微信上显示的数字验证码（无需验证码时直接回车跳过）：'),
  });

  const account: WeixinAccount = {
    id: result.accountId,
    token: result.token,
    baseUrl: result.baseUrl || DEFAULT_WEIXIN_BASE_URL,
    ...(result.userId ? { userId: result.userId } : {}),
    loggedInAt: new Date().toISOString(),
  };
  await saveWeixinAccount(runtime.appPaths.profileDir, account);

  // Register the account + bind the scanner as owner in the profile config so
  // the policy layer never has to infer identity from credentials.
  const root = await loadRootConfig(runtime.configPath);
  if (!root) throw new Error(`找不到配置文件：${runtime.configPath}`);
  const profileConfig = root.profiles[runtime.profile];
  if (!profileConfig) throw new Error(`profile 不存在：${runtime.profile}`);
  const weixin = profileConfig.weixin ?? { accounts: [] };
  const others = weixin.accounts.filter((entry) => entry.id !== account.id);
  root.profiles[runtime.profile] = {
    ...profileConfig,
    channel: { kind: 'weixin' },
    weixin: {
      ...weixin,
      accounts: [
        ...others,
        { id: account.id, ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) },
      ],
      ...(weixin.ownerId || !account.userId ? {} : { ownerId: account.userId }),
    },
  };
  await saveRootConfig(root, runtime.configPath);

  console.log('\n✅ 已连接微信：');
  console.log(`   账号: ${account.id}`);
  console.log(`   绑定用户: ${account.userId ?? '(未知)'}`);
  console.log(`   凭证目录: ${runtime.appPaths.profileDir}/weixin/`);
  console.log(`\n接下来运行：lark-channel-bridge run --profile ${runtime.profile}\n`);
}

export interface WeixinSendOptions {
  config?: string;
  profile?: string;
  to: string;
  text: string;
  account?: string;
}

/**
 * `weixin send`: one-shot outbound text. Handy for checking a freshly
 * logged-in account (credentials, base URL, recipient id) before starting the
 * full bridge.
 */
export async function runWeixinSend(opts: WeixinSendOptions): Promise<void> {
  const runtime = await resolveProfileRuntime({
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    allowBootstrap: false,
  });
  requireWeixinProfile(runtime.profileConfig, runtime.profile);
  const configured = runtime.profileConfig.weixin?.accounts ?? [];
  const accountId = opts.account ?? configured[0]?.id;
  if (!accountId) {
    throw new Error('该 profile 还没有登录任何微信账号：先运行 `lark-channel-bridge weixin login`。');
  }
  const account = await loadWeixinAccount(runtime.appPaths.profileDir, accountId);
  if (!account) {
    throw new Error(`找不到账号 ${accountId} 的本地凭证（${runtime.appPaths.profileDir}/weixin/）。`);
  }
  const port = createWeixinChannelPort(account);
  const result = await port.send(opts.to, { kind: 'text', text: opts.text });
  console.log(`已发送：messageId=${result.messageId}`);
}
