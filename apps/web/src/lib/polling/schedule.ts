/** A poller's schedule: how long to wait before checking again, or when to stop altogether. */

/** The interval production polls at, and every `WORKER_MODE` except `stubbed` (see
 * `pollIntervalMsForWorkerMode`).
 *
 * This is the base rate that `nextPollDelayMs` doubles on each consecutive failure
 * up to `BACKOFF_CAP_MS`. */
export const BASE_POLL_INTERVAL_MS = 10_000;

/** `stubbed` mode fakes the whole lifecycle and speeds up the worker config with
 * `STUBBED_OVERRIDES` in `apps/worker/src/modes.ts`. So, we can show results on screen
 * much faster and aren't worried about pegging a prod server */
const STUBBED_POLL_INTERVAL_MS = 1_000;

/** The longest the schedule ever waits, no matter how long a run of failures gets. */
const BACKOFF_CAP_MS = 60_000;

/** The number of consecutive poll failures before the page says anything about it. */
export const FAILURES_BEFORE_NOTICE = 2;

/** The interval to poll the report page at for a given `WORKER_MODE`.
 *
 * Only `stubbed` gets the fast interval. `mock-llm` is meant to feel like production, cadence
 * included, and `live`/`off` *are* production or off — matching `apps/worker/src/modes.ts`'s own
 * reasoning for which modes get `STUBBED_OVERRIDES`. An unset or unrecognised mode falls back to
 * the production interval.
 */
export function pollIntervalMsForWorkerMode(workerMode: string | undefined): number {
  return workerMode === 'stubbed' ? STUBBED_POLL_INTERVAL_MS : BASE_POLL_INTERVAL_MS;
}

/** How long to wait before polling again, or `undefined` to stop.
 *
 * - `settled`: a terminal report, or a list with nothing left running, will not change again
 *   without a user action, so there is nothing left to poll for.
 * - `documentHidden`: a backgrounded tab stops polling too. The caller polls immediately instead
 *   on `visibilitychange` back to visible, rather than waiting out whatever delay was pending.
 * - `consecutiveFailures`: each one doubles `baseIntervalMs` — so a real outage doesn't keep
 *   hammering the server at the same steady cadence — capped at `BACKOFF_CAP_MS`.
 * - `baseIntervalMs`: the un-backed-off interval, from `pollIntervalMsForWorkerMode`. Browser
 *   code can't read `WORKER_MODE` itself (`$env/dynamic/private` is server-only), so the caller
 *   threads it down from `+page.server.ts` instead of this module importing a constant.
 */
export function nextPollDelayMs(state: {
  settled: boolean;
  documentHidden: boolean;
  consecutiveFailures: number;
  baseIntervalMs: number;
}): number | undefined {
  if (state.settled || state.documentHidden) return undefined;
  if (state.consecutiveFailures === 0) return state.baseIntervalMs;
  return Math.min(state.baseIntervalMs * 2 ** state.consecutiveFailures, BACKOFF_CAP_MS);
}
