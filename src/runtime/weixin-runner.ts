/**
 * WeChat DM → DSH session orchestration.
 *
 * This is the WeChat counterpart of the Lark bridge loop in `src/bot/channel.ts`,
 * kept deliberately small: one private conversation per peer, fail-closed
 * allow-list, a minimal slash-command set, and one serial run at a time. It
 * reuses the channel-neutral kernel (run-flow / run-executor / session /
 * workspace stores) and only owns the parts that are specific to WeChat:
 * inbound text extraction, typing heartbeat, append-only final reply and the
 * `context_token` echo.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityFor, type AgentCapability } from '../agent/capability';
import type { AgentAdapter } from '../agent/types';
import { ActiveRuns } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import { recordRunSessionEvent, startRunFlow } from '../bot/run-flow';
import {
  MessageItemType,
  WeixinQuoteStore,
  type WeixinAccount,
  type WeixinChannelPort,
  type WeixinInboundMessage,
} from '../channel/weixin';
import { log } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import type { RunPolicyAllow } from '../policy/run-policy';
import { writeFileAtomic } from '../platform/atomic-write';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import { createRuntimeAgent } from './agent-runtime';
import type { ProfileRuntime } from './profile-runtime';
import { RunExecutor, type RunExecution } from './run-executor';

export interface WeixinRunnerDeps {
  runtime: ProfileRuntime;
  account: WeixinAccount;
  port: WeixinChannelPort;
  /** Injectable agent factory (tests pass a fake agent). */
  createAgent?: () => AgentAdapter;
  /** Injectable clock (tests pass a deterministic one). */
  now?: () => number;
  /** Test seam: progress-message thresholds (ms). Defaults to [8s, 20s]. */
  progressDelaysMs?: readonly number[];
  /** User↔bot rounds allowed per conversation before new DSH runs are blocked. */
  maxSessionTurns?: number;
}

export interface WeixinRunner {
  /**
   * Consume one inbound DM.
   *
   * Commands are handled inline (so `/stop` can interrupt a run), plain text is
   * queued and this resolves as soon as it is scheduled — NOT when the run
   * finishes. The transport awaits this method per message; blocking it for the
   * duration of a long run would stop the long-poll loop from reading `/stop`.
   * Use {@link whenIdle} to wait for queued work.
   */
  handleInbound(msg: WeixinInboundMessage): Promise<void>;
  /** Resolve once the queue has drained and no run is active. */
  whenIdle(): Promise<void>;
  /** Stop accepting work, interrupt the active run and flush stores. */
  stop(): Promise<void>;
}

interface Stores {
  sessions: SessionStore;
  workspaces: WorkspaceStore;
}

interface CollectedRun {
  text: string;
  errorMessage?: string;
}

type TypingHandle = Awaited<ReturnType<WeixinChannelPort['startTyping']>>;

const COMMAND_HELP = [
  '微信桥接可用命令：',
  '/new 或 /reset  开始新会话',
  '/stop           停止当前运行',
  '/status         查看当前状态',
  '/help           查看本帮助',
  '直接发送文字即可与 DSH 对话。',
].join('\n');

const USAGE_HINT = '未知命令。发送 /help 查看可用命令；直接输入文字可与 DSH 对话。';

const TEXT_ONLY_HINT = '目前只支持文本消息，图片/文件将在后续版本支持。';

/**
 * Soft-guidance threshold, in user↔bot rounds, for suggesting `/new`.
 *
 * Live testing showed the WeChat server has no hard 10-round cap (16
 * consecutive messages delivered fine), so this is a UX hint only: no turn is
 * ever blocked and every user message still reaches DSH. TODO(P1.5): expose as
 * `weixin.maxSessionTurns` in ProfileConfig instead of a runner constant.
 */
export const WEIXIN_MAX_SESSION_TURNS = 50;

/** Hard cap on outbound messages one run may emit (progress + final + errors). */
export const WEIXIN_MAX_RUN_OUTBOUND_MESSAGES = 5;

/** Progress messages fire after these run durations (never more than two). */
export const WEIXIN_PROGRESS_DELAYS_MS: readonly number[] = [8_000, 20_000];

/** Appended once when the conversation reaches half of the threshold. */
export const WEIXIN_TURN_LONG_NOTICE = '（当前会话较长，如需重新开始可发送 /new）';

export const WEIXIN_TURN_REPEATED_NOTICE =
  '（消息交互次数较多，建议使用 /new 命令重新开启新会话）';

/**
 * Which soft hint (if any) is due for a 1-based used-turn count.
 *
 *   - usedTurns >= maxTurns              → `repeated` (every reply from then on)
 *   - usedTurns >= ceil(maxTurns / 2)    → `long` (first time only, caller flags)
 * For the default 50 that means round 25 (once) and round 50 onward.
 */
export function weixinTurnSoftNotice(
  usedTurns: number,
  maxTurns: number = WEIXIN_MAX_SESSION_TURNS,
): 'long' | 'repeated' | undefined {
  if (usedTurns >= maxTurns) return 'repeated';
  if (usedTurns >= Math.ceil(maxTurns / 2)) return 'long';
  return undefined;
}

export const WEIXIN_TURNS_FILE = 'turns.json';

/** `<profileDir>/weixin/turns.json` — persisted per-conversation turn counts. */
export function weixinTurnsPath(profileDir: string): string {
  return join(profileDir, 'weixin', WEIXIN_TURNS_FILE);
}

/** Stable bucket key for one account's conversation with one peer. */
export function weixinTurnBucketKey(accountId: string, peer: string): string {
  return `${accountId}|${peer}`;
}

interface TurnsFile {
  version: 1;
  turns: Record<string, number>;
}

/**
 * Persisted user↔bot turn counts (mode 0600).
 *
 * Counting semantics: one "turn" is a user message that gets accepted for a
 * DSH run — the counter is incremented when the message is accepted, so it
 * reads as "user message → bot reply" once the reply completes. `/new` and
 * `/reset` clear the peer's count; the value survives restarts via
 * `<profileDir>/weixin/turns.json`. The soft `/new` hints are derived from
 * {@link weixinTurnSoftNotice} / `maxSessionTurns`; turns are never blocked.
 */
export class WeixinTurnCounter {
  private readonly turns = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly profileDir: string,
    private readonly accountId: string,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(weixinTurnsPath(this.profileDir), 'utf8'),
      ) as Partial<TurnsFile> | undefined;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) return;
      if (!raw.turns || typeof raw.turns !== 'object') return;
      for (const [key, value] of Object.entries(raw.turns)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          this.turns.set(key, Math.floor(value));
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('weixin', 'turns-load-failed', { err: errorMessage(err) });
    }
  }

  get(peer: string): number {
    return this.turns.get(weixinTurnBucketKey(this.accountId, peer)) ?? 0;
  }

  increment(peer: string): number {
    const key = weixinTurnBucketKey(this.accountId, peer);
    const next = (this.turns.get(key) ?? 0) + 1;
    this.turns.set(key, next);
    this.schedulePersist();
    return next;
  }

  reset(peer: string): void {
    this.turns.delete(weixinTurnBucketKey(this.accountId, peer));
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        const file: TurnsFile = {
          version: 1,
          turns: Object.fromEntries([...this.turns.entries()]),
        };
        await writeFileAtomic(
          weixinTurnsPath(this.profileDir),
          `${JSON.stringify(file, null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('weixin', err, { step: 'turns-persist' });
      });
  }
}

/** Per-run outbound budget so progress chatter can never crowd out the reply. */
export class RunOutboundBudget {
  private used = 0;

  constructor(readonly limit: number = WEIXIN_MAX_RUN_OUTBOUND_MESSAGES) {}

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  get usedCount(): number {
    return this.used;
  }
}

/** One WeChat peer's private scope, namespaced away from Lark open_ids. */
export function weixinDmScope(peer: string): string {
  return `wx:dm:${peer}`;
}

export function createWeixinRunner(deps: WeixinRunnerDeps): WeixinRunner {
  return new WeixinRunnerImpl(deps);
}

class WeixinRunnerImpl implements WeixinRunner {
  private readonly runtime: ProfileRuntime;
  private readonly port: WeixinChannelPort;
  private readonly now: () => number;
  private readonly agent: AgentAdapter;
  private readonly capability: AgentCapability;
  private readonly executor: RunExecutor;
  private readonly startedAt: number;

  private storesPromise: Promise<Stores> | undefined;
  private current: RunExecution | undefined;
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly quotes: WeixinQuoteStore;
  private readonly turns: WeixinTurnCounter;
  private readonly progressDelaysMs: readonly number[];
  private readonly maxSessionTurns: number;
  private quotesReady: Promise<void> | undefined;
  private turnsReady: Promise<void> | undefined;
  /** Peers that already received the one-shot "long conversation" hint. */
  private readonly longTurnNoticeSent = new Set<string>();

  constructor(deps: WeixinRunnerDeps) {
    this.runtime = deps.runtime;
    this.port = deps.port;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.maxSessionTurns = Math.max(1, deps.maxSessionTurns ?? WEIXIN_MAX_SESSION_TURNS);
    this.progressDelaysMs = deps.progressDelaysMs ?? WEIXIN_PROGRESS_DELAYS_MS;
    this.quotes = new WeixinQuoteStore(deps.runtime.appPaths.profileDir, deps.account.id, {
      now: this.now,
    });
    this.turns = new WeixinTurnCounter(deps.runtime.appPaths.profileDir, deps.account.id);
    this.capability = capabilityFor(deps.runtime.profileConfig);
    this.agent =
      deps.createAgent?.() ??
      createRuntimeAgent(deps.runtime.profileConfig, {
        ...deps.runtime.appPaths,
        configPath: deps.runtime.configPath,
      });
    this.executor = new RunExecutor({
      agent: this.agent,
      // The runner serializes runs itself (one DM conversation, one run), so the
      // pool only ever needs one slot.
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      now: this.now,
    });
  }

  async handleInbound(msg: WeixinInboundMessage): Promise<void> {
    if (this.stopped) return;
    const access = this.accessFor(msg.peer);
    if (!access) {
      log.info('weixin', 'inbound-denied', { peerFingerprint: fingerprint(msg.peer) });
      return;
    }
    const text = extractInboundText(msg);
    if (!text) {
      await this.send(msg.peer, TEXT_ONLY_HINT, msg.contextToken);
      return;
    }
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text);
      return;
    }

    await this.ensureQuotes();
    const messageId = msg.message.message_id?.trim();
    if (messageId) {
      this.quotes.record(msg.peer, { id: messageId, text, kind: 'user' });
    }
    const quoted = this.buildQuotedContext(msg);

    await this.ensureTurns();
    const nextTurn = this.turns.increment(msg.peer);
    const prompt = quoted ? `${quoted}\n\n${text}` : text;
    this.scheduleRun(msg, prompt, access, nextTurn);
  }

  private ensureQuotes(): Promise<void> {
    this.quotesReady ??= this.quotes.load();
    return this.quotesReady;
  }

  private ensureTurns(): Promise<void> {
    this.turnsReady ??= this.turns.load();
    return this.turnsReady;
  }

  /**
   * Resolve a quoted message (`item.ref_msg.message_item.msg_id`) from the
   * local quote ring, falling back to the inline text the client sent (or an
   * explicit "unavailable" marker when neither exists).
   */
  private buildQuotedContext(msg: WeixinInboundMessage): string | undefined {
    for (const item of msg.message.item_list ?? []) {
      const ref = item.ref_msg;
      const refId = ref?.message_item?.msg_id?.trim();
      if (!refId) continue;
      const known = this.quotes.find(msg.peer, refId);
      const inline =
        ref?.message_item?.text_item?.text?.trim() || ref?.title?.trim() || undefined;
      const content = known?.text ?? inline;
      const from = known?.kind ?? 'unknown';
      const body = content ?? '引用了某条消息（内容不可用）';
      return `<quoted_message id="${refId}" from="${from}">\n${body}\n</quoted_message>`;
    }
    return undefined;
  }

  async whenIdle(): Promise<void> {
    // Loop until the tail stops moving: tasks enqueued while we were awaiting
    // the previous tail must also settle before the queue counts as idle.
    for (;;) {
      const tail = this.tail;
      await tail.catch(() => undefined);
      if (tail === this.tail) return;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const current = this.current;
    if (current) {
      await current.stop().catch((err) => {
        log.warn('weixin', 'runner-stop-run-failed', { err: errorMessage(err) });
      });
    }
    // Queued tasks observe `stopped` and return immediately, so this settles fast.
    await this.tail.catch(() => undefined);
    if (this.storesPromise) {
      const stores = await this.storesPromise.catch(() => undefined);
      if (stores) {
        await Promise.allSettled([stores.sessions.flush(), stores.workspaces.flush()]);
      }
    }
    await Promise.allSettled([this.quotes.flush(), this.turns.flush()]);
    log.info('weixin', 'runner-stopped', { profile: this.runtime.profile });
  }

  // ── access ───────────────────────────────────────────────────────────────

  /** Fail-closed: only the login owner or an explicit allow-list entry may DM. */
  private accessFor(peer: string): AccessDecision | undefined {
    const weixin = this.runtime.profileConfig.weixin;
    const ownerId = weixin?.ownerId;
    if (ownerId !== undefined && ownerId !== '' && peer === ownerId) {
      return { ok: true, reason: 'owner' };
    }
    if (weixin?.allowedUsers?.includes(peer)) {
      return { ok: true, reason: 'allowed-user' };
    }
    return undefined;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private async handleCommand(msg: WeixinInboundMessage, text: string): Promise<void> {
    const command = (text.trim().split(/\s+/, 1)[0] ?? '').toLowerCase();
    switch (command) {
      case '/help':
        await this.send(msg.peer, COMMAND_HELP, msg.contextToken);
        return;
      case '/new':
      case '/reset':
        await this.resetSession(msg);
        return;
      case '/stop':
        await this.stopCurrentRun(msg);
        return;
      case '/status':
        await this.sendStatus(msg);
        return;
      default:
        await this.send(msg.peer, USAGE_HINT, msg.contextToken);
    }
  }

  private async resetSession(msg: WeixinInboundMessage): Promise<void> {
    const { sessions } = await this.ensureStores();
    const scopeId = weixinDmScope(msg.peer);
    sessions.clear(scopeId);
    // A new DSH session also starts a fresh server-side conversation budget.
    await this.ensureTurns();
    this.turns.reset(msg.peer);
    this.longTurnNoticeSent.delete(msg.peer);
    await this.send(
      msg.peer,
      '已开始新会话，下一条消息会新建 DSH session（会话轮次计数已重置）。',
      msg.contextToken,
    );
  }

  private async stopCurrentRun(msg: WeixinInboundMessage): Promise<void> {
    const current = this.current;
    if (!current) {
      await this.send(msg.peer, '当前没有正在运行的任务。', msg.contextToken);
      return;
    }
    await current.stop().catch((err) => {
      log.warn('weixin', 'stop-run-failed', { err: errorMessage(err) });
    });
    await this.send(msg.peer, '已请求停止当前运行。', msg.contextToken);
  }

  private async sendStatus(msg: WeixinInboundMessage): Promise<void> {
    const { sessions } = await this.ensureStores();
    await this.ensureTurns();
    const profileConfig = this.runtime.profileConfig;
    const scopeId = weixinDmScope(msg.peer);
    const session = sessions.getRaw(scopeId);
    const model = profileConfig.preferences.model ?? '默认（未指定）';
    const cwd = profileConfig.workspaces.default ?? '（未设置）';
    const lines = [
      '微信私聊状态',
      `- agent: ${profileConfig.agentKind}`,
      `- model: ${model}`,
      `- cwd: ${cwd}`,
      `- 会话: ${session?.sessionId ? '有' : '无'}`,
      `- 运行中: ${this.current ? '是' : '否'}`,
      `- 轮次: ${this.turns.get(msg.peer)}/${this.maxSessionTurns}`,
      `- 运行时长: ${formatDuration(this.now() - this.startedAt)}`,
    ];
    await this.send(msg.peer, lines.join('\n'), msg.contextToken);
  }

  // ── run ──────────────────────────────────────────────────────────────────

  /** Append the derived `/new` hint to a reply; never blocks the run. */
  private decorateTurnNotice(peer: string, text: string, turn: number): string {
    const notice = weixinTurnSoftNotice(turn, this.maxSessionTurns);
    if (notice === 'repeated') return `${text}\n\n${WEIXIN_TURN_REPEATED_NOTICE}`;
    if (notice === 'long' && !this.longTurnNoticeSent.has(peer)) {
      this.longTurnNoticeSent.add(peer);
      return `${text}\n\n${WEIXIN_TURN_LONG_NOTICE}`;
    }
    return text;
  }

  /**
   * Queue a run without making the transport wait for it. The previous tail
   * settles first (serial runs), and every rejection is observed here so a
   * failed run can never surface as an unhandled rejection.
   */
  private scheduleRun(
    msg: WeixinInboundMessage,
    prompt: string,
    access: AccessDecision,
    turn: number,
  ): void {
    const task = async (): Promise<void> => {
      if (this.stopped) return;
      await this.runPrompt(msg, prompt, access, turn);
    };
    const next = this.tail.then(task, task);
    next.catch((err: unknown) => {
      log.fail('weixin', err, { step: 'inbound-run', profile: this.runtime.profile });
    });
    this.tail = next.catch(() => undefined);
  }

  private async runPrompt(
    msg: WeixinInboundMessage,
    prompt: string,
    access: AccessDecision,
    turn: number,
  ): Promise<void> {
    const { sessions, workspaces } = await this.ensureStores();
    const scopeId = weixinDmScope(msg.peer);
    let typing: TypingHandle | undefined = await this.startTyping(msg.peer);
    const startedAt = this.now();
    const budget = new RunOutboundBudget();
    const toolNames = new Map<string, number>();
    const progressTimers: NodeJS.Timeout[] = [];
    let execution: RunExecution | undefined;
    try {
      const result = await startRunFlow({
        scopeId,
        scope: { source: 'im', chatId: msg.peer, actorId: msg.peer },
        prompt,
        attachments: [],
        access,
        capability: this.capability,
        profileConfig: this.runtime.profileConfig,
        sessions,
        workspaces,
        executor: this.executor,
        now: this.now(),
        observability: {
          profile: this.runtime.profile,
          agent: this.agent.id,
          source: 'weixin',
          stage: 'dm',
        },
      });
      if (!result.ok) {
        await this.sendRunText(msg, `⚠️ ${result.rejectReason.userVisible}`, budget);
        return;
      }
      execution = result.execution;
      this.current = execution;
      progressTimers.push(...this.startProgress(msg, startedAt, toolNames, budget));
      const collected = await this.collect(execution, result.policy, sessions, scopeId, toolNames);
      // Stop the progress timers before the final reply: otherwise a timer that
      // fires while the answer is being sent appends "still running" after it.
      for (const timer of progressTimers) clearTimeout(timer);
      progressTimers.length = 0;
      await this.stopTyping(typing);
      typing = undefined;
      // `/stop` already replied; an interrupted run must not append a stale
      // "no output" / "failed" message after the user asked it to stop.
      if (execution.handle.interrupted) return;

      const elapsedMs = this.now() - startedAt;
      const footer = formatFooter(elapsedMs, totalTools(toolNames));
      if (collected.errorMessage) {
        await this.sendRunText(
          msg,
          this.decorateTurnNotice(
            msg.peer,
            `⚠️ 运行失败：${collected.errorMessage}`,
            turn,
          ),
          budget,
        );
        return;
      }
      const body = collected.text.trim();
      if (body === '') {
        await this.sendRunText(
          msg,
          this.decorateTurnNotice(msg.peer, `本轮没有输出。${footer}`, turn),
          budget,
        );
        return;
      }
      await this.sendRunText(
        msg,
        this.decorateTurnNotice(msg.peer, `${body}${footer}`, turn),
        budget,
      );
    } catch (err) {
      log.fail('weixin', err, { step: 'run', profile: this.runtime.profile });
      await this.sendRunText(msg, `⚠️ 运行失败：${errorMessage(err)}`, budget);
    } finally {
      for (const timer of progressTimers) clearTimeout(timer);
      if (this.current === execution) this.current = undefined;
      await this.stopTyping(typing);
    }
  }

  /** Emit at most two progress lines at the configured thresholds. */
  private startProgress(
    msg: WeixinInboundMessage,
    startedAt: number,
    toolNames: Map<string, number>,
    budget: RunOutboundBudget,
  ): NodeJS.Timeout[] {
    const timers: NodeJS.Timeout[] = [];
    for (const delay of this.progressDelaysMs.slice(0, 2)) {
      const timer = setTimeout(() => {
        if (this.stopped) return;
        const seconds = Math.max(1, Math.round((this.now() - startedAt) / 1000));
        const text = `⏳ 仍在执行（已 ${seconds}s，已调用工具 ${totalTools(toolNames)} 次）`;
        void this.sendRunText(msg, text, budget);
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }
    return timers;
  }

  /** Send one run-lifecycle message, enforcing the per-run outbound budget. */
  private async sendRunText(
    msg: WeixinInboundMessage,
    text: string,
    budget: RunOutboundBudget,
  ): Promise<void> {
    if (!budget.take()) {
      log.warn('weixin', 'run-outbound-budget-exhausted', {
        limit: budget.limit,
        profile: this.runtime.profile,
      });
      return;
    }
    await this.send(msg.peer, text, msg.contextToken);
  }

  private async collect(
    execution: RunExecution,
    policy: RunPolicyAllow,
    sessions: SessionStore,
    scopeId: string,
    toolNames: Map<string, number>,
  ): Promise<CollectedRun> {
    let finalText: string | undefined;
    let buffer = '';
    let errorMessage: string | undefined;
    for await (const event of execution.subscribe()) {
      switch (event.type) {
        case 'system':
          recordRunSessionEvent({
            scopeId,
            sessions,
            capability: this.capability,
            policy,
            event,
          });
          break;
        case 'text':
          buffer += event.delta;
          break;
        case 'final_text':
          finalText = event.content;
          break;
        case 'tool_use':
          toolNames.set(event.name, (toolNames.get(event.name) ?? 0) + 1);
          break;
        case 'error':
          errorMessage = event.message;
          break;
        default:
          break;
      }
    }
    return {
      text: finalText ?? buffer,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  // ── io helpers ───────────────────────────────────────────────────────────

  private async send(peer: string, text: string, contextToken?: string): Promise<void> {
    // During shutdown the transport may already be going away; a late reply is
    // dropped rather than logged as a send failure.
    if (this.stopped) return;
    try {
      const result = await this.port.send(
        peer,
        { kind: 'text', text },
        contextToken ? { contextToken } : undefined,
      );
      // Remember the bot side too, so a later quoted reply resolves to it.
      await this.ensureQuotes();
      for (const id of [result.messageId, ...(result.chunkIds ?? [])]) {
        if (id) this.quotes.record(peer, { id, text, kind: 'bot' });
      }
    } catch (err) {
      log.fail('weixin', err, { step: 'send', profile: this.runtime.profile });
    }
  }

  private async startTyping(peer: string): Promise<TypingHandle | undefined> {
    try {
      return await this.port.startTyping(peer);
    } catch (err) {
      // Typing is cosmetic: a missing ticket must never block the reply.
      log.warn('weixin', 'typing-start-failed', { err: errorMessage(err) });
      return undefined;
    }
  }

  private async stopTyping(typing: TypingHandle | undefined): Promise<void> {
    if (!typing) return;
    await typing.stop().catch((err) => {
      log.warn('weixin', 'typing-stop-failed', { err: errorMessage(err) });
    });
  }

  private ensureStores(): Promise<Stores> {
    this.storesPromise ??= (async (): Promise<Stores> => {
      const sessions = new SessionStore(this.runtime.appPaths.sessionsFile);
      const workspaces = new WorkspaceStore(this.runtime.appPaths.workspacesFile);
      await Promise.all([sessions.load(), workspaces.load()]);
      return { sessions, workspaces };
    })();
    return this.storesPromise;
  }
}

/** Extract the plain text of an inbound message (text items only for now). */
export function extractInboundText(msg: WeixinInboundMessage): string {
  const parts: string[] = [];
  for (const item of msg.message.item_list ?? []) {
    if (item.type !== MessageItemType.TEXT) continue;
    const text = item.text_item?.text?.trim();
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

/** One-line run footer: elapsed time plus tool-call count when any ran. */
export function formatFooter(elapsedMs: number, toolCount: number): string {
  const parts = [`耗时 ${formatDuration(elapsedMs)}`];
  if (toolCount > 0) parts.push(`工具 ${toolCount} 次`);
  return `\n\n— ${parts.join(' · ')}`;
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe}ms`;
  const seconds = safe / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m${rest}s`;
}

/** Log-safe peer reference: never log the raw WeChat user id. */
function fingerprint(peer: string): string {
  if (peer.length <= 6) return '***';
  return `${peer.slice(0, 3)}***${peer.slice(-3)}`;
}

function totalTools(toolNames: Map<string, number>): number {
  let total = 0;
  for (const count of toolNames.values()) total += count;
  return total;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
