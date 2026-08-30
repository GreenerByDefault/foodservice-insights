import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 5;

/** Comfortably under vitest's 30s per-test timeout (`testTimeout` in `vitest.config.ts`, raised
 * for Supabase Storage contention), so a failure is reported here — naming what was being waited
 * for — rather than as an anonymous timeout on the test. */
const DEFAULT_TIMEOUT_MS = 20_000;

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
