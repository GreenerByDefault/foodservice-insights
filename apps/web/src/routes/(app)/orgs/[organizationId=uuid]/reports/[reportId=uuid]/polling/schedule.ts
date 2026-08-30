/** The report page's polling schedule: how long to wait before checking again, or when to stop
 * altogether. */

/** How often to poll.
 *
 * This is the base rate that `nextPollDelayMs` doubles on each consecutive failure
 * up to `BACKOFF_CAP_MS`. */
export const BASE_POLL_INTERVAL_MS = 10_000;

/** The longest the schedule ever waits, no matter how long a run of failures gets. */
const BACKOFF_CAP_MS = 60_000;

/** The number of consecutive poll failures before the page says anything about it. */
export const FAILURES_BEFORE_NOTICE = 2;

/** How long to wait before polling again, or `undefined` to stop.
 *
 * - `settled`: a terminal report will not change again without a user action, so there is
 *   nothing left to poll for.
 * - `hidden`: a backgrounded tab stops polling too. The caller polls immediately instead on
 *   `visibilitychange` back to visible, rather than waiting out whatever delay was pending.
 * - `consecutiveFailures`: each one doubles the wait — 10s, 20s, 40s, capped at 60s — so a real
 *   outage doesn't keep hammering the server every ten seconds.
 */
export function nextPollDelayMs(state: {
  settled: boolean;
  hidden: boolean;
  consecutiveFailures: number;
}): number | undefined {
  if (state.settled || state.hidden) return undefined;
  if (state.consecutiveFailures === 0) return BASE_POLL_INTERVAL_MS;
  return Math.min(BASE_POLL_INTERVAL_MS * 2 ** state.consecutiveFailures, BACKOFF_CAP_MS);
}
