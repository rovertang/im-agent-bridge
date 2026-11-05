import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEIXIN_MIN_SEND_INTERVAL_MS,
  createOutboundThrottle,
} from '../../../src/channel/weixin';

afterEach(() => {
  vi.useRealTimers();
});

describe('weixin outbound rate limit', () => {
  it('sends the first message immediately and spaces the rest by 300ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    const starts: number[] = [];
    const throttle = createOutboundThrottle(WEIXIN_MIN_SEND_INTERVAL_MS);

    const first = throttle.schedule(async () => {
      starts.push(Date.now());
    });
    const second = throttle.schedule(async () => {
      starts.push(Date.now());
    });
    const third = throttle.schedule(async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);

    await vi.advanceTimersByTimeAsync(299);
    expect(starts).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 300]);

    await vi.advanceTimersByTimeAsync(300);
    expect(starts).toEqual([0, 300, 600]);

    await Promise.all([first, second, third]);
    expect(WEIXIN_MIN_SEND_INTERVAL_MS).toBe(300);
  });

  it('keeps the queue moving when one message fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    let secondRan = false;
    const throttle = createOutboundThrottle(100);

    const failing = throttle.schedule(async () => {
      throw new Error('boom');
    });
    const next = throttle.schedule(async () => {
      secondRan = true;
    });

    await expect(failing).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
  });
});
