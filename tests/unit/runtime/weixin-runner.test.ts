import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import type {
  ChannelPayload,
  ChannelSendOptions,
  ChannelSendResult,
  ChannelStreamRequest,
} from '../../../src/channel/port';
import {
  MessageItemType,
  WEIXIN_CAPABILITIES,
  type WeixinAccount,
  type WeixinChannelPort,
  type WeixinInboundMessage,
  type WeixinTypingHandle,
} from '../../../src/channel/weixin';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { ProfileRuntime } from '../../../src/runtime/profile-runtime';
import {
  RunOutboundBudget,
  WEIXIN_MAX_RUN_OUTBOUND_MESSAGES,
  WEIXIN_MAX_SESSION_TURNS,
  WEIXIN_TURN_LONG_NOTICE,
  WEIXIN_TURN_REPEATED_NOTICE,
  WeixinTurnCounter,
  createWeixinRunner,
  extractInboundText,
  formatDuration,
  formatFooter,
  weixinTurnSoftNotice,
  weixinTurnsPath,
  type WeixinRunner,
} from '../../../src/runtime/weixin-runner';

const ACCOUNT: WeixinAccount = {
  id: 'acct@im.test',
  token: 'super-secret-token',
  baseUrl: 'https://example.invalid',
  userId: 'owner-1',
  name: 'WeChat Bot',
  loggedInAt: new Date(0).toISOString(),
};

const roots: string[] = [];
const runners: WeixinRunner[] = [];
let clock = 1_700_000_000_000;
let messageSeq = 0;

afterEach(async () => {
  await Promise.allSettled(runners.splice(0).map((runner) => stopRunner(runner)));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A test that fails while a run is gated must not hang the hook forever. */
async function stopRunner(runner: WeixinRunner): Promise<void> {
  await Promise.race([
    runner.stop(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// ── fakes ──────────────────────────────────────────────────────────────────

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface SentMessage {
  peer: string;
  payload: ChannelPayload;
  opts?: ChannelSendOptions;
}

class FakePort implements WeixinChannelPort {
  readonly kind = 'weixin' as const;
  readonly capabilities = WEIXIN_CAPABILITIES;
  readonly identity = { id: ACCOUNT.id, name: ACCOUNT.name };
  readonly sent: SentMessage[] = [];
  readonly typingStarts: string[] = [];
  readonly typingStops: string[] = [];

  async send(
    peer: string,
    payload: ChannelPayload,
    opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    this.sent.push({ peer, payload, ...(opts ? { opts } : {}) });
    return { messageId: `msg-${this.sent.length}` };
  }

  async openStream(
    _peer: string,
    _request: ChannelStreamRequest,
    _opts?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    throw new Error('weixin does not support streaming');
  }

  async recall(): Promise<void> {
    throw new Error('weixin does not support recall');
  }

  async addReaction(): Promise<string | undefined> {
    throw new Error('weixin does not support reactions');
  }

  async removeReaction(): Promise<void> {
    throw new Error('weixin does not support reactions');
  }

  async startTyping(peer: string): Promise<WeixinTypingHandle> {
    this.typingStarts.push(peer);
    return {
      stop: async (): Promise<void> => {
        this.typingStops.push(peer);
      },
    };
  }

  textAt(index: number): string {
    const payload = this.sent[index]?.payload;
    return payload?.kind === 'text' ? payload.text : '';
  }
}

interface AgentScript {
  events: AgentEvent[];
  /** Awaited before the first event; lets a test keep one run in flight. */
  gate?: Gate;
}

class ScriptedAgent implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'Scripted DSH';
  readonly runs: AgentRunOptions[] = [];
  readonly stops: number[] = [];
  private readonly scripts: AgentScript[];

  constructor(scripts: AgentScript[] = []) {
    this.scripts = [...scripts];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const index = this.runs.length;
    this.runs.push(opts);
    const script = this.scripts.shift() ?? { events: [] };
    let stopped = false;
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      if (script.gate) await script.gate.promise;
      if (stopped) return;
      for (const event of script.events) {
        if (stopped) return;
        yield event;
      }
    })();
    return {
      runId: opts.runId,
      events,
      stop: async (): Promise<void> => {
        stopped = true;
        this.stops.push(index);
        script.gate?.resolve();
      },
      waitForExit: async (): Promise<boolean> => true,
    };
  }
}

interface Harness {
  runner: WeixinRunner;
  port: FakePort;
  agent: ScriptedAgent;
  runtime: ProfileRuntime;
  appPaths: ReturnType<typeof resolveAppPaths>;
}

async function makeHarness(options: {
  scripts?: AgentScript[];
  ownerId?: string;
  allowedUsers?: string[];
  progressDelaysMs?: readonly number[];
  maxSessionTurns?: number;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-weixin-runner-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const appPaths = resolveAppPaths({ rootDir: root, profile: 'wx' });
  await mkdir(appPaths.profileDir, { recursive: true });

  const profileConfig = createDefaultProfileConfig({
    agentKind: 'dsh',
    channel: { kind: 'weixin' },
    weixin: {
      accounts: [{ id: ACCOUNT.id }],
      ownerId: options.ownerId ?? 'owner-1',
      ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
    },
    dsh: { binaryPath: '/bin/echo' },
  });
  profileConfig.workspaces.default = await realpath(workspace);

  const runtime: ProfileRuntime = {
    profileConfig,
    configPath: join(root, 'config.json'),
    appPaths,
    profile: 'wx',
  };
  const port = new FakePort();
  const agent = new ScriptedAgent(options.scripts);
  const runner = createWeixinRunner({
    runtime,
    account: ACCOUNT,
    port,
    createAgent: () => agent,
    now: () => clock,
    ...(options.progressDelaysMs ? { progressDelaysMs: options.progressDelaysMs } : {}),
    ...(options.maxSessionTurns !== undefined
      ? { maxSessionTurns: options.maxSessionTurns }
      : {}),
  });
  runners.push(runner);
  return { runner, port, agent, runtime, appPaths };
}

function inbound(peer: string, text: string, contextToken = 'ctx-1'): WeixinInboundMessage {
  messageSeq += 1;
  return {
    message: {
      message_id: String(messageSeq),
      from_user_id: peer,
      message_type: 1,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      context_token: contextToken,
    },
    peer,
    contextToken,
    receivedAt: clock,
  };
}

function nonTextInbound(peer: string): WeixinInboundMessage {
  messageSeq += 1;
  return {
    message: {
      message_id: String(messageSeq),
      from_user_id: peer,
      message_type: 1,
      item_list: [{ type: MessageItemType.IMAGE }],
    },
    peer,
    receivedAt: clock,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const doneEvent: AgentEvent = { type: 'done', terminationReason: 'normal' };

// ── tests ──────────────────────────────────────────────────────────────────

describe('weixin run helpers', () => {
  it('extracts text items and ignores non-text ones', () => {
    const msg = inbound('owner-1', 'hello');
    msg.message.item_list = [
      { type: MessageItemType.TEXT, text_item: { text: ' first ' } },
      { type: MessageItemType.IMAGE },
      { type: MessageItemType.TEXT, text_item: { text: 'second' } },
    ];
    expect(extractInboundText(msg)).toBe('first\nsecond');
    expect(extractInboundText(nonTextInbound('owner-1'))).toBe('');
  });

  it('formats durations and run footers', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m5s');
    expect(formatFooter(1200, 2)).toContain('耗时 1.2s');
    expect(formatFooter(1200, 2)).toContain('工具 2 次');
    expect(formatFooter(1200, 0)).not.toContain('工具');
  });
});

describe('weixin runner access control', () => {
  it('silently ignores a sender that is neither owner nor allow-listed', async () => {
    const { runner, port, agent } = await makeHarness({ ownerId: 'owner-1' });

    await runner.handleInbound(inbound('stranger', 'hi'));

    expect(port.sent).toHaveLength(0);
    expect(agent.runs).toHaveLength(0);
  });

  it('accepts an allow-listed user even when they are not the owner', async () => {
    const { runner, port, agent } = await makeHarness({
      ownerId: 'owner-1',
      allowedUsers: ['friend-1'],
      scripts: [{ events: [{ type: 'final_text', content: 'friend reply' }, doneEvent] }],
    });

    await runner.handleInbound(inbound('friend-1', 'hi'));
    await runner.whenIdle();

    expect(agent.runs).toHaveLength(1);
    expect(port.textAt(0)).toContain('friend reply');
  });

  it('replies with a hint for unsupported non-text messages', async () => {
    const { runner, port, agent } = await makeHarness({ ownerId: 'owner-1' });

    await runner.handleInbound(nonTextInbound('owner-1'));

    expect(agent.runs).toHaveLength(0);
    expect(port.textAt(0)).toContain('只支持文本消息');
  });
});

describe('weixin runner plain-text runs', () => {
  it('shows typing, sends the final text with contextToken and a footer', async () => {
    const { runner, port, appPaths } = await makeHarness({
      ownerId: 'owner-1',
      scripts: [
        {
          events: [
            { type: 'system', sessionId: 'sess-1' },
            { type: 'text', delta: 'Hel' },
            { type: 'text', delta: 'lo' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'thinking', delta: 'hmm' },
            { type: 'final_text', content: 'Hello!' },
            doneEvent,
          ],
        },
      ],
    });

    await runner.handleInbound(inbound('owner-1', 'hello', 'ctx-42'));
    await runner.whenIdle();

    expect(port.typingStarts).toEqual(['owner-1']);
    expect(port.typingStops).toEqual(['owner-1']);
    expect(port.sent).toHaveLength(1);
    const reply = port.textAt(0);
    expect(reply).toContain('Hello!');
    expect(reply).not.toContain('hmm');
    expect(reply).toContain('工具 1 次');
    expect(port.sent[0]?.opts?.contextToken).toBe('ctx-42');
    expect(port.sent[0]?.peer).toBe('owner-1');

    await runner.stop();
    const sessions = JSON.parse(await readFile(appPaths.sessionsFile, 'utf8')) as Record<
      string,
      { sessionId?: string }
    >;
    expect(sessions['wx:dm:owner-1']?.sessionId).toBe('sess-1');
  });

  it('falls back to streamed text when no final_text event arrives', async () => {
    const { runner, port } = await makeHarness({
      scripts: [{ events: [{ type: 'text', delta: 'streamed answer' }, doneEvent] }],
    });

    await runner.handleInbound(inbound('owner-1', 'hello'));
    await runner.whenIdle();

    expect(port.textAt(0)).toContain('streamed answer');
  });

  it('resumes the recorded DSH session on the next message', async () => {
    const { runner, agent } = await makeHarness({
      scripts: [
        {
          events: [
            { type: 'system', sessionId: 'sess-9' },
            { type: 'final_text', content: 'first' },
            doneEvent,
          ],
        },
        { events: [{ type: 'final_text', content: 'second' }, doneEvent] },
      ],
    });

    await runner.handleInbound(inbound('owner-1', 'first'));
    await runner.whenIdle();
    await runner.handleInbound(inbound('owner-1', 'second'));
    await runner.whenIdle();

    expect(agent.runs).toHaveLength(2);
    expect(agent.runs[1]?.sessionId).toBe('sess-9');
  });

  it('reports an empty run without dropping the typing lifecycle', async () => {
    const { runner, port } = await makeHarness({
      scripts: [{ events: [{ type: 'system', sessionId: 'sess-1' }, doneEvent] }],
    });

    await runner.handleInbound(inbound('owner-1', 'hello'));
    await runner.whenIdle();

    expect(port.textAt(0)).toContain('本轮没有输出');
    expect(port.typingStarts).toHaveLength(1);
    expect(port.typingStops).toHaveLength(1);
  });

  it('sends a failure message and stops typing when the agent errors', async () => {
    const { runner, port } = await makeHarness({
      scripts: [
        {
          events: [
            { type: 'system', sessionId: 'sess-1' },
            { type: 'error', message: 'boom', terminationReason: 'failed' },
          ],
        },
      ],
    });

    await runner.handleInbound(inbound('owner-1', 'hello', 'ctx-err'));
    await runner.whenIdle();

    expect(port.textAt(0)).toContain('⚠️ 运行失败：boom');
    expect(port.sent[0]?.opts?.contextToken).toBe('ctx-err');
    expect(port.typingStops).toEqual(['owner-1']);
  });

  it('returns from handleInbound immediately while the run is still active', async () => {
    const gate = deferred();
    const { runner, port, agent } = await makeHarness({
      scripts: [{ gate, events: [{ type: 'final_text', content: 'late reply' }, doneEvent] }],
    });

    // The run cannot finish before the gate opens, so resolving here proves the
    // transport is not blocked by it (otherwise `/stop` would queue behind the run).
    await runner.handleInbound(inbound('owner-1', 'sleep 20'));
    await waitFor(() => agent.runs.length === 1);
    expect(port.sent).toHaveLength(0);

    gate.resolve();
    await runner.whenIdle();
    expect(port.sent).toHaveLength(1);
    expect(port.textAt(0)).toContain('late reply');
  });

  it('whenIdle resolves only after the queued run finishes', async () => {
    const gate = deferred();
    const { runner, agent } = await makeHarness({
      scripts: [{ gate, events: [{ type: 'final_text', content: 'ok' }, doneEvent] }],
    });

    await runner.handleInbound(inbound('owner-1', 'hi'));
    await waitFor(() => agent.runs.length === 1);
    let idle = false;
    const idlePromise = runner.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);

    gate.resolve();
    await idlePromise;
    expect(idle).toBe(true);
  });

  it('serializes a second message until the first run completes', async () => {
    const gate = deferred();
    const { runner, port, agent } = await makeHarness({
      scripts: [
        { gate, events: [{ type: 'final_text', content: 'first reply' }, doneEvent] },
        { events: [{ type: 'final_text', content: 'second reply' }, doneEvent] },
      ],
    });

    await runner.handleInbound(inbound('owner-1', 'one'));
    await waitFor(() => agent.runs.length === 1);
    await runner.handleInbound(inbound('owner-1', 'two'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agent.runs).toHaveLength(1);
    expect(agent.runs[0]?.prompt).toBe('one');

    gate.resolve();
    await runner.whenIdle();

    expect(agent.runs).toHaveLength(2);
    expect(agent.runs[1]?.prompt).toBe('two');
    expect(port.sent).toHaveLength(2);
    expect(port.textAt(0)).toContain('first reply');
    expect(port.textAt(1)).toContain('second reply');
  });

  it('interrupts the active run on /stop while queued work still settles', async () => {
    const gate = deferred();
    const { runner, port, agent } = await makeHarness({
      scripts: [{ gate, events: [doneEvent] }],
    });

    await runner.handleInbound(inbound('owner-1', 'long task'));
    await waitFor(() => agent.runs.length === 1);

    await runner.handleInbound(inbound('owner-1', '/stop'));

    expect(port.sent).toHaveLength(1);
    expect(port.textAt(0)).toContain('已请求停止当前运行');
    expect(agent.stops).toHaveLength(1);

    await runner.whenIdle();
    // The interrupted run must not append its trailing reply after /stop.
    expect(port.sent).toHaveLength(1);
  });
});

describe('weixin runner commands', () => {
  it('/help lists the minimal command set', async () => {
    const { runner, port } = await makeHarness();

    await runner.handleInbound(inbound('owner-1', '/help'));

    const reply = port.textAt(0);
    expect(reply).toContain('/new');
    expect(reply).toContain('/stop');
    expect(reply).toContain('/status');
  });

  it('/status reports agent, model, cwd and run state without the token', async () => {
    const { runner, port, runtime } = await makeHarness();

    await runner.handleInbound(inbound('owner-1', '/status'));

    const reply = port.textAt(0);
    expect(reply).toContain('agent: dsh');
    expect(reply).toContain(`cwd: ${runtime.profileConfig.workspaces.default}`);
    expect(reply).toContain('会话: 无');
    expect(reply).toContain('运行中: 否');
    expect(reply).toContain('运行时长:');
    expect(reply).not.toContain(ACCOUNT.token);
  });

  it('/new clears the stored session', async () => {
    const { runner, port, appPaths } = await makeHarness({
      scripts: [
        { events: [{ type: 'system', sessionId: 'sess-1' }, doneEvent] },
      ],
    });

    await runner.handleInbound(inbound('owner-1', 'remember me'));
    await runner.whenIdle();
    await runner.handleInbound(inbound('owner-1', '/new'));

    expect(port.textAt(1)).toContain('已开始新会话');
    await runner.stop();
    const sessions = JSON.parse(await readFile(appPaths.sessionsFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(sessions['wx:dm:owner-1']).toBeUndefined();
  });

  it('answers unknown slash commands with the usage hint', async () => {
    const { runner, port } = await makeHarness();

    await runner.handleInbound(inbound('owner-1', '/wat'));

    expect(port.textAt(0)).toContain('未知命令');
    expect(port.textAt(0)).toContain('/help');
  });

  it('stop() aborts the active run and skips queued messages', async () => {
    const gate = deferred();
    const { runner, port, agent } = await makeHarness({
      scripts: [{ gate, events: [doneEvent] }],
    });

    await runner.handleInbound(inbound('owner-1', 'one'));
    await waitFor(() => agent.runs.length === 1);
    await runner.handleInbound(inbound('owner-1', 'two'));

    await runner.stop();
    await runner.whenIdle();

    expect(agent.runs).toHaveLength(1);
    expect(port.sent).toHaveLength(0);
  });
});

// ── P1.4: quote context, progress, rate/turn limits ───────────────────────

function refQuote(
  msg: WeixinInboundMessage,
  refId: string,
  extras: { title?: string; inlineText?: string } = {},
): WeixinInboundMessage {
  const first = msg.message.item_list?.[0] ?? { type: MessageItemType.TEXT };
  msg.message.item_list = [
    {
      ...first,
      ref_msg: {
        message_item: {
          ...(extras.inlineText ? { text_item: { text: extras.inlineText } } : {}),
          msg_id: refId,
        },
        ...(extras.title ? { title: extras.title } : {}),
      },
    },
  ];
  return msg;
}

function quickScripts(count: number, prefix = 'ok'): AgentScript[] {
  return Array.from({ length: count }, (_, index) => ({
    events: [
      { type: 'final_text' as const, content: `${prefix} ${index + 1}` },
      doneEvent,
    ],
  }));
}

describe('weixin runner quote context', () => {
  it('injects a quoted bot message into the next prompt by message id', async () => {
    const { runner, port, agent } = await makeHarness({ scripts: quickScripts(2) });

    await runner.handleInbound(inbound('owner-1', 'first question'));
    await runner.whenIdle();
    expect(port.sent).toHaveLength(1);
    const replyId = 'msg-1'; // FakePort's first outbound id

    await runner.handleInbound(refQuote(inbound('owner-1', 'quote that'), replyId));
    await runner.whenIdle();

    const prompt = agent.runs[1]?.prompt ?? '';
    expect(prompt).toContain(`<quoted_message id="${replyId}" from="bot">`);
    expect(prompt).toContain('ok 1');
    expect(prompt).toContain('quote that');
  });

  it('falls back to inline quote text, then to an unavailable marker', async () => {
    const { runner, agent } = await makeHarness({ scripts: quickScripts(2) });

    await runner.handleInbound(
      refQuote(inbound('owner-1', 'a'), 'unknown-1', { inlineText: 'inline old text' }),
    );
    await runner.whenIdle();
    expect(agent.runs[0]?.prompt).toContain('<quoted_message id="unknown-1" from="unknown">');
    expect(agent.runs[0]?.prompt).toContain('inline old text');

    await runner.handleInbound(refQuote(inbound('owner-1', 'b'), 'unknown-2'));
    await runner.whenIdle();
    expect(agent.runs[1]?.prompt).toContain('引用了某条消息（内容不可用）');
  });
});

describe('weixin runner progress messages', () => {
  it('sends at most two progress lines while keeping typing alive', async () => {
    const gate = deferred();
    const { runner, port } = await makeHarness({
      scripts: [{ gate, events: [{ type: 'final_text', content: 'done later' }, doneEvent] }],
      progressDelaysMs: [10, 25],
    });

    await runner.handleInbound(inbound('owner-1', 'long task'));
    await waitFor(() => port.sent.length >= 2, 3000);

    expect(port.sent).toHaveLength(2);
    expect(port.textAt(0)).toContain('⏳ 仍在执行');
    expect(port.textAt(1)).toContain('⏳ 仍在执行');
    expect(port.typingStops).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(port.sent).toHaveLength(2);

    gate.resolve();
    await runner.whenIdle();
    expect(port.typingStops).toEqual(['owner-1']);
    expect(port.textAt(2)).toContain('done later');
  });
});

describe('weixin runner soft turn hints', () => {
  it('adds the long hint once at round 25 and repeated hints from round 50, never blocking DSH', async () => {
    const { runner, port, agent } = await makeHarness({
      scripts: quickScripts(WEIXIN_MAX_SESSION_TURNS + 1),
    });
    const replies: string[] = [];
    for (let turn = 1; turn <= WEIXIN_MAX_SESSION_TURNS; turn += 1) {
      await runner.handleInbound(inbound('owner-1', `turn ${turn}`));
      await runner.whenIdle();
      replies.push(port.textAt(port.sent.length - 1));
    }

    expect(WEIXIN_MAX_SESSION_TURNS).toBe(50);
    expect(agent.runs).toHaveLength(50);
    // ceil(50/2)=25 → the one-shot hint appears at round 25 only.
    expect(replies[23]).not.toContain('当前会话较长');
    expect(replies[24]).toContain('当前会话较长');
    expect(replies[25]).not.toContain('当前会话较长');
    expect(replies[48]).not.toContain('消息交互次数较多');
    expect(replies[49]).toContain('消息交互次数较多');
    expect(replies[49]).not.toContain('当前会话较长');

    // Round 51 is still answered by DSH, with the repeated hint appended.
    await runner.handleInbound(inbound('owner-1', 'turn 51'));
    await runner.whenIdle();
    expect(agent.runs).toHaveLength(51);
    const last = port.textAt(port.sent.length - 1);
    expect(last).toContain('ok 51');
    expect(last).toContain('消息交互次数较多');
  });

  it('derives hint rounds from maxSessionTurns (limit 4: once at round 2, every reply from round 4)', async () => {
    const { runner, port, agent } = await makeHarness({
      scripts: quickScripts(5),
      maxSessionTurns: 4,
    });
    const replies: string[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      await runner.handleInbound(inbound('owner-1', `turn ${turn}`));
      await runner.whenIdle();
      replies.push(port.textAt(port.sent.length - 1));
    }

    expect(agent.runs).toHaveLength(5); // no turn is ever blocked
    expect(replies[0]).not.toContain('当前会话较长');
    expect(replies[1]).toContain('当前会话较长');
    expect(replies[2]).not.toContain('当前会话较长');
    expect(replies[3]).toContain('消息交互次数较多');
    expect(replies[4]).toContain('消息交互次数较多');
    expect(replies[4]).toContain('ok 5');
  });

  it('resets the counter and the one-shot hint on /new', async () => {
    const { runner, port, agent, appPaths } = await makeHarness({
      scripts: quickScripts(6),
      maxSessionTurns: 4,
    });
    for (let turn = 1; turn <= 4; turn += 1) {
      await runner.handleInbound(inbound('owner-1', `turn ${turn}`));
      await runner.whenIdle();
    }
    expect(port.textAt(port.sent.length - 1)).toContain('消息交互次数较多');

    await runner.handleInbound(inbound('owner-1', '/new'));
    await runner.handleInbound(inbound('owner-1', 'fresh start'));
    await runner.whenIdle();
    expect(agent.runs).toHaveLength(5);
    expect(port.textAt(port.sent.length - 1)).toContain('ok 5');
    expect(port.textAt(port.sent.length - 1)).not.toContain('当前会话较长');
    expect(port.textAt(port.sent.length - 1)).not.toContain('消息交互次数较多');

    // The one-shot hint fires again after the reset once the count reaches half.
    await runner.handleInbound(inbound('owner-1', 'second turn'));
    await runner.whenIdle();
    expect(port.textAt(port.sent.length - 1)).toContain('当前会话较长');

    await runner.stop();
    const persisted = JSON.parse(
      await readFile(weixinTurnsPath(appPaths.profileDir), 'utf8'),
    ) as { turns: Record<string, number> };
    expect(persisted.turns[`${ACCOUNT.id}|owner-1`]).toBe(2);
  });
});

describe('weixin runner turn store helpers', () => {
  it('persists per-peer counts as 0600 and resumes them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-weixin-turns-'));
    roots.push(root);
    const profileDir = join(root, 'profiles', 'wx');
    await mkdir(join(profileDir, 'weixin'), { recursive: true });

    const first = new WeixinTurnCounter(profileDir, ACCOUNT.id);
    await first.load();
    first.increment('owner-1');
    first.increment('owner-1');
    first.increment('owner-1');
    first.increment('other-peer');
    await first.flush();

    const file = weixinTurnsPath(profileDir);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    const second = new WeixinTurnCounter(profileDir, ACCOUNT.id);
    await second.load();
    expect(second.get('owner-1')).toBe(3);
    expect(second.get('other-peer')).toBe(1);
    second.reset('owner-1');
    await second.flush();

    const third = new WeixinTurnCounter(profileDir, ACCOUNT.id);
    await third.load();
    expect(third.get('owner-1')).toBe(0);
  });

  it('maps used turns to the soft hint copy and caps a run at five outbound messages', () => {
    expect(WEIXIN_MAX_SESSION_TURNS).toBe(50);
    expect(WEIXIN_TURN_LONG_NOTICE).toContain('当前会话较长');
    expect(WEIXIN_TURN_REPEATED_NOTICE).toContain('消息交互次数较多');

    expect(weixinTurnSoftNotice(24)).toBeUndefined();
    expect(weixinTurnSoftNotice(25)).toBe('long');
    expect(weixinTurnSoftNotice(49)).toBe('long');
    expect(weixinTurnSoftNotice(50)).toBe('repeated');
    expect(weixinTurnSoftNotice(51)).toBe('repeated');
    // Custom threshold 4: half at round 2, repeated from round 4.
    expect(weixinTurnSoftNotice(1, 4)).toBeUndefined();
    expect(weixinTurnSoftNotice(2, 4)).toBe('long');
    expect(weixinTurnSoftNotice(4, 4)).toBe('repeated');

    const budget = new RunOutboundBudget();
    for (let index = 0; index < WEIXIN_MAX_RUN_OUTBOUND_MESSAGES; index += 1) {
      expect(budget.take()).toBe(true);
    }
    expect(budget.take()).toBe(false);
    expect(budget.usedCount).toBe(WEIXIN_MAX_RUN_OUTBOUND_MESSAGES);
  });
});

function textOf(entry: SentMessage): string {
  return entry.payload.kind === 'text' ? entry.payload.text : '';
}
