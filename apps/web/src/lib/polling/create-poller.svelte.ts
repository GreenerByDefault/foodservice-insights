/** A repeating poll loop, generic over what it polls. Pauses while the tab is hidden and catches
 * up immediately when it becomes visible again. */

import { onMount, untrack } from 'svelte';
import { FAILURES_BEFORE_NOTICE, nextPollDelayMs } from './schedule.ts';

export interface PollerOptions<T> {
  /** Rejects on a network or API failure; a rejection is what drives `connectionStatus` and the
   * backoff, never the returned value. */
  poll: () => Promise<T>;
  /** Whether polling should stop — a getter, so it re-reads reactive state on every check rather
   * than closing over a value from when `createPoller` was called. */
  isSettled: () => boolean;
  /** The un-backed-off interval to poll at, in ms — a getter for the same reason as `isSettled`. */
  pollIntervalMs: () => number;
  onData: (data: T) => void;
}

export interface Poller {
  readonly connectionStatus: 'ok' | 'retrying';
  /** Polls right away, bypassing whatever delay is currently pending. */
  pollNow: () => Promise<void>;
}

/** Runs `options.poll` on a repeating, backed-off schedule and reports each result via
 * `options.onData`, until `options.isSettled` says to stop.
 *
 * Must be called during component initialization — it uses `$effect` and `onMount`, which both
 * require that.
 */
export function createPoller<T>(options: PollerOptions<T>): Poller {
  let consecutiveFailures = $state(0);
  let documentHidden = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Set by the `onMount` cleanup below. `clearTimeout` only cancels a poll that hasn't started
   * yet — one already awaiting `options.poll` keeps running after unmount, and without this guard
   * its `finally` would write to this (now-orphaned) poller's state and arm a timer nothing can
   * ever clear again, which is how a single leaked poll turns into a permanent per-instance loop. */
  let destroyed = false;

  function scheduleNext(): void {
    clearTimeout(timer);
    const delayMs = nextPollDelayMs({
      settled: options.isSettled(),
      documentHidden,
      consecutiveFailures,
      baseIntervalMs: options.pollIntervalMs(),
    });
    timer = delayMs === undefined ? undefined : setTimeout(pollNow, delayMs);
  }

  async function pollNow(): Promise<void> {
    try {
      const next = await options.poll();
      if (destroyed) return;
      options.onData(next);
      consecutiveFailures = 0;
    } catch {
      if (destroyed) return;
      consecutiveFailures += 1;
    } finally {
      if (!destroyed) scheduleNext();
    }
  }

  /** Starts and stops the loop above, which cannot do either for itself. Each poll arms the next
   * one, so the chain keeps going once it is going. But nothing in it notices data becoming
   * pollable again from a standstill — a retry un-settling it, or a swap onto new, unsettled data. */
  $effect(() => {
    if (options.isSettled() || documentHidden) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    // untrack keeps the dependencies to exactly the two conditions above. scheduleNext also reads
    // consecutiveFailures, and re-running this on every failed poll would fight the backoff the
    // chain is already applying.
    untrack(scheduleNext);
  });

  function onVisibilityChange(): void {
    documentHidden = document.hidden;
    // Catch up right away rather than waiting out the delay the effect above is arming.
    if (!documentHidden && !options.isSettled()) pollNow();
  }

  onMount(() => {
    documentHidden = document.hidden;
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      destroyed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  return {
    get connectionStatus() {
      return consecutiveFailures >= FAILURES_BEFORE_NOTICE ? 'retrying' : 'ok';
    },
    pollNow,
  };
}
