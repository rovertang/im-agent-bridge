import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { ChannelPort } from '../../../src/channel/port';
import { tryHandleCommand, type Controls } from '../../../src/commands/index';
import { createDefaultProfileConfig, requireLarkProfile } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeAgent } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import {
  createFakeChannelPort,
  createFakeTextOnlyChannelPort,
} from '../../helpers/fake-channel-port';
import { createTmpProfile } from '../../helpers/tmp-profile';

const FEISHU_ONLY_REPLY = '该命令仅在飞书渠道可用。';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('channel capability gating for Feishu-only commands', () => {
  it.each(['/account', '/config', '/new chat', '/meeting', '/invite all group'])(
    'answers %s with the Feishu-only notice on a plain-text channel',
    async (command) => {
      const h = await createHarness('weixin');

      await expect(h.run(command)).resolves.toBe(true);

      expect(h.lastMarkdown()).toContain(FEISHU_ONLY_REPLY);
      expect(h.channel.sent).toHaveLength(1);
    },
  );

  it('keeps the plain-text channel usable for channel-neutral commands', async () => {
    const h = await createHarness('weixin');

    await expect(h.run('/cd')).resolves.toBe(true);

    expect(h.lastMarkdown()).toContain('用法');
  });

  it('does not gate Feishu-only commands on the Lark channel', async () => {
    const h = await createHarness('lark');

    await expect(h.run('/meeting')).resolves.toBe(true);

    expect(h.lastMarkdown()).toContain('会议智能体未启用');
    expect(h.lastMarkdown()).not.toContain(FEISHU_ONLY_REPLY);
  });
});

async function createHarness(kind: 'lark' | 'weixin'): Promise<{
  channel: ReturnType<typeof createFakeChannel>;
  run(content: string): Promise<boolean>;
  lastMarkdown(): string;
}> {
  const tmp = await createTmpProfile(`commands-channel-gating-${kind}-`);
  cleanups.push(() => tmp.cleanup());
  const channel = createFakeChannel();
  const port: ChannelPort =
    kind === 'lark' ? createFakeChannelPort(channel) : createFakeTextOnlyChannelPort(channel);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = requireLarkProfile(
    createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { admins: ['ou-admin'] },
    }),
  );
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  return {
    channel,
    run: (content: string): Promise<boolean> =>
      tryHandleCommand({
        channel: port,
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
    lastMarkdown: (): string => {
      const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
      expect(content?.markdown).toBeTypeOf('string');
      return content?.markdown as string;
    },
  };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
