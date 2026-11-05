/**
 * Shared fetch mocking for the Weixin unit tests.
 *
 * The protocol layer only talks HTTP through the global `fetch`, so tests
 * install a fake fetch and assert on the recorded requests. No real network
 * access happens anywhere in these suites.
 */
import { vi } from 'vitest';

export interface FetchCall {
  readonly url: URL;
  readonly method: string;
  /** Header names are lower-cased (mirrors the `Headers` API). */
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  /** Caller abort signal (long-poll cancellation); undefined when not passed. */
  readonly signal: AbortSignal | undefined;
}

export interface FetchReply {
  status?: number;
  body?: string;
}

export type FetchHandler = (call: FetchCall) => FetchReply | Promise<FetchReply>;

/** A 200 response with a JSON body. */
export function jsonResponse(payload: unknown, status = 200): FetchReply {
  return { status, body: JSON.stringify(payload) };
}

/** A 200 response with an empty body (the service does this on success). */
export function emptyResponse(): FetchReply {
  return { status: 200, body: '' };
}

interface HeaderCollection {
  forEach(callback: (value: string, key: string) => void): void;
}

function toHeaderRecord(init: RequestInit['headers'] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!init) return record;
  if (Array.isArray(init)) {
    for (const [key, value] of init as unknown as ReadonlyArray<readonly [string, string]>) {
      record[key.toLowerCase()] = value;
    }
    return record;
  }
  if (typeof (init as Partial<HeaderCollection>).forEach === 'function') {
    (init as HeaderCollection).forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
  for (const [key, value] of Object.entries(init as Record<string, string | undefined>)) {
    if (value !== undefined) record[key.toLowerCase()] = String(value);
  }
  return record;
}

/**
 * Install a global fetch stub backed by `handler`; returns the recorded calls.
 * The caller is responsible for `vi.unstubAllGlobals()` in `afterEach`.
 */
export function installFetchMock(handler: FetchHandler): {
  calls: FetchCall[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      const call: FetchCall = {
        url,
        method: init?.method ?? 'GET',
        headers: toHeaderRecord(init?.headers),
        body: typeof init?.body === 'string' ? init.body : undefined,
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      const reply = await handler(call);
      return new Response(reply.body ?? '', { status: reply.status ?? 200 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** A DOMException-shaped `AbortError` like real fetch throws. */
export function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Simulate a long-poll that never answers: the promise rejects with an
 * `AbortError` as soon as `call.signal` aborts (exactly like real fetch).
 */
export function pendingUntilAbort(call: FetchCall): Promise<FetchReply> {
  return new Promise<FetchReply>((_resolve, reject) => {
    if (!call.signal) return; // never resolves; leaks only if the test is broken
    if (call.signal.aborted) {
      reject(abortError());
      return;
    }
    call.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

/** Requests recorded against one endpoint path. */
export function callsTo(calls: readonly FetchCall[], pathname: string): FetchCall[] {
  return calls.filter((call) => call.url.pathname === pathname);
}

/** Parse a recorded request body as JSON. */
export function bodyOf<T>(call: FetchCall | undefined): T {
  if (!call?.body) throw new Error('expected a recorded request with a JSON body');
  return JSON.parse(call.body) as T;
}
