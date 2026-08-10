/** Poll-until-true, which is the only kind of waiting the worker's tests do.
 *
 * "The child has reached point X" is always a file the child creates, never a sleep long enough to
 * probably be enough. Polling for the effect is deterministic in *outcome*: the wait ends as soon
 * as the thing happens, and the only way to reach the timeout is for the code under test to be
 * broken. Same argument, and the same 5ms, as `POLL_INTERVAL_MS` in
 * [`@gbd/db`'s concurrency harness](../../../../packages/db/src/testing/concurrency.ts).
 */

import { setTimeout as delay } from 'node:timers/promises';

const POLL_INTERVAL_MS = 5;

/** Comfortably under vitest's 5s per-test timeout, so a failure is reported here — naming what was
 * being waited for — rather than as an anonymous timeout on the test. */
const DEFAULT_TIMEOUT_MS = 4_000;

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
