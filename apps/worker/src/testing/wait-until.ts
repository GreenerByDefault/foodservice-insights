import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 5;

/** Sized against what convergence actually takes, not against `testTimeout` (30s in
 * `vitest.config.ts`, raised separately for Supabase Storage contention in #52). Even under the
 * CI load that caused #167, every real wait here — a DB write, a blob
 * store round trip, a child process writing a file — settled in under 1.1s. 10s keeps close to an
 * order of magnitude of margin over that while still failing well before `testTimeout` would, so
 * a failure is reported here — naming what was being waited for — rather than as an anonymous
 * timeout on the test. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Waits for a condition by polling, instead of sleeping for a duration and hoping it was long
 * enough.
 *
 * The worker's tests wait on things like "the child process wrote its output file" — a fact that
 * becomes true at an unpredictable time, not on a schedule. Polling for it directly makes the
 * wait deterministic in *outcome*: it resolves the instant the condition is true, and the only
 * way to hit the timeout is for the code under test to be broken. Same argument, and the same
 * 5ms poll interval, as `POLL_INTERVAL_MS` in
 * [`@gbd/db`'s concurrency harness](../../../../packages/db/src/testing/concurrency.ts).
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting until ${description}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}
