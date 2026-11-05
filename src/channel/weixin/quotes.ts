/**
 * WeChat conversation quote store.
 *
 * WeChat is append-only and exposes replies as `ref_msg.message_item.msg_id`
 * instead of inlining the quoted text. The bridge keeps a small, per
 * account+peer ring of recently seen message ids → text so a reply can be
 * resolved back into prompt context (`<quoted_message>`).
 *
 * Persistence: `<profileDir>/weixin/quotes.json` (mode 0600), because the
 * quoted text is user/bot conversation content rather than credentials — it
 * still must never be world-readable.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';

/** Which side of the conversation wrote a remembered message. */
export type WeixinQuoteKind = 'user' | 'bot';

/** One remembered message. */
export interface WeixinQuoteEntry {
  /** Channel message id (`WeixinMessage.message_id` / send result id). */
  id: string;
  /** Plain-text content used when the message is quoted later. */
  text: string;
  kind: WeixinQuoteKind;
  /** Epoch ms when recorded. */
  at: number;
}

/** Per-bucket retention: enough for a long back-and-forth, small on disk. */
export const WEIXIN_QUOTE_LIMIT = 500;

const QUOTES_FILE = 'quotes.json';
const QUOTES_VERSION = 1;

interface QuotesFile {
  version: 1;
  buckets: Record<string, WeixinQuoteEntry[]>;
}

export function weixinQuoteStorePath(profileDir: string): string {
  return join(profileDir, 'weixin', QUOTES_FILE);
}

/** Stable bucket key for one account's conversation with one peer. */
export function weixinQuoteBucketKey(accountId: string, peer: string): string {
  return `${accountId}|${peer}`;
}

export interface WeixinQuoteStoreOptions {
  /** Ring size (default {@link WEIXIN_QUOTE_LIMIT}); tests use a small value. */
  limit?: number;
  /** Injectable clock. */
  now?: () => number;
}

/**
 * Ring-buffered quote store for one WeChat profile.
 *
 * `load()` must complete before the first `record()`/`find()`, otherwise a
 * later `flush()` would overwrite the on-disk history with an empty in-memory
 * map. The runner awaits it once per process.
 */
export class WeixinQuoteStore {
  private readonly buckets = new Map<string, WeixinQuoteEntry[]>();
  private readonly limit: number;
  private readonly now: () => number;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly profileDir: string,
    private readonly accountId: string,
    options: WeixinQuoteStoreOptions = {},
  ) {
    this.limit = Math.max(1, options.limit ?? WEIXIN_QUOTE_LIMIT);
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(weixinQuoteStorePath(this.profileDir), 'utf8')) as
        | Partial<QuotesFile>
        | undefined;
      if (!raw || typeof raw !== 'object' || raw.version !== QUOTES_VERSION) return;
      const buckets = raw.buckets;
      if (!buckets || typeof buckets !== 'object') return;
      for (const [key, entries] of Object.entries(buckets)) {
        if (!Array.isArray(entries)) continue;
        this.buckets.set(key, entries.filter(isQuoteEntry).slice(-this.limit));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('weixin', 'quotes-load-failed', { err: errorMessage(err) });
    }
  }

  /** Remember a message; re-recording the same id refreshes its content. */
  record(peer: string, entry: { id: string; text: string; kind: WeixinQuoteKind }): void {
    const id = entry.id.trim();
    const text = entry.text.trim();
    if (!id || !text) return;
    const key = weixinQuoteBucketKey(this.accountId, peer);
    const bucket = this.buckets.get(key) ?? [];
    const next = bucket.filter((candidate) => candidate.id !== id);
    next.push({ id, text, kind: entry.kind, at: this.now() });
    while (next.length > this.limit) next.shift();
    this.buckets.set(key, next);
    this.schedulePersist();
  }

  find(peer: string, id: string): WeixinQuoteEntry | undefined {
    const bucket = this.buckets.get(weixinQuoteBucketKey(this.accountId, peer));
    if (!bucket) return undefined;
    const wanted = id.trim();
    if (!wanted) return undefined;
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const entry = bucket[index];
      if (entry?.id === wanted) return entry;
    }
    return undefined;
  }

  /** Snapshot for tests/diagnostics (oldest first). */
  entries(peer: string): readonly WeixinQuoteEntry[] {
    return [...(this.buckets.get(weixinQuoteBucketKey(this.accountId, peer)) ?? [])];
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        const file: QuotesFile = {
          version: QUOTES_VERSION,
          buckets: Object.fromEntries([...this.buckets.entries()]),
        };
        await writeFileAtomic(
          weixinQuoteStorePath(this.profileDir),
          `${JSON.stringify(file, null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('weixin', err, { step: 'quotes-persist' });
      });
  }
}

function isQuoteEntry(value: unknown): value is WeixinQuoteEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<WeixinQuoteEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.text === 'string' &&
    (entry.kind === 'user' || entry.kind === 'bot') &&
    typeof entry.at === 'number'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
