import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { BASE_POLL_INTERVAL_MS } from './schedule.ts';
import PollerHarness from './testing/poller-harness.svelte';
import { triggerImmediatePoll } from './testing/trigger-immediate-poll.ts';

function connectionStatus(screen: Awaited<ReturnType<typeof render>>): string | null | undefined {
  return screen.container.querySelector('[data-testid="connection-status"]')?.textContent;
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

describe('createPoller', () => {
  test('a single failure leaves connectionStatus ok; a second in a row trips it to retrying', async () => {
    const poll = vi.fn().mockRejectedValue(new Error('boom'));
    const screen = await render(PollerHarness, {
      poll,
      settled: false,
      pollIntervalMs: BASE_POLL_INTERVAL_MS,
      onData: vi.fn(),
    });

    await triggerImmediatePoll();
    await expect.poll(() => connectionStatus(screen)).toBe('ok');

    await triggerImmediatePoll();
    await expect.poll(() => connectionStatus(screen)).toBe('retrying');
  });

  test('a success clears connectionStatus back to ok after a run of failures', async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('data');
    const screen = await render(PollerHarness, {
      poll,
      settled: false,
      pollIntervalMs: BASE_POLL_INTERVAL_MS,
      onData: vi.fn(),
    });

    await triggerImmediatePoll();
    await triggerImmediatePoll();
    await expect.poll(() => connectionStatus(screen)).toBe('retrying');

    await triggerImmediatePoll();
    await expect.poll(() => connectionStatus(screen)).toBe('ok');
  });

  test('resumes polling on its own schedule when settled flips to unsettled, with no pollNow call', async () => {
    // The poller's effect stops the timer once settled — and, unlike a retry, flipping settled
    // back to false never calls pollNow itself to re-arm it. This is the one path that has to
    // notice the swap on its own, so it needs the real schedule (fake timers) rather than the
    // visibilitychange shortcut the other tests use.
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue('data');
    const onData = vi.fn();
    const screen = await render(PollerHarness, {
      poll,
      settled: true,
      pollIntervalMs: BASE_POLL_INTERVAL_MS,
      onData,
    });

    await screen.rerender({ poll, settled: false, pollIntervalMs: BASE_POLL_INTERVAL_MS, onData });
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BASE_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  test('a poll in flight when the component unmounts is ignored on resolution, and arms no further timer', async () => {
    // Exercises the `destroyed` guard: without it, the in-flight poll's `finally` would write to
    // this (now-orphaned) instance's state and re-arm a timer nothing could ever clear again.
    vi.useFakeTimers();
    let resolvePoll: (value: string) => void = () => {};
    const poll = vi.fn(() => new Promise<string>((resolve) => (resolvePoll = resolve)));
    const onData = vi.fn();
    const screen = await render(PollerHarness, {
      poll,
      settled: false,
      pollIntervalMs: BASE_POLL_INTERVAL_MS,
      onData,
    });
    await vi.advanceTimersByTimeAsync(BASE_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    await screen.unmount();
    resolvePoll('data');
    await vi.advanceTimersByTimeAsync(0);

    expect(onData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BASE_POLL_INTERVAL_MS * 10);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
