/** The worker's one retry layer for a database call — `one-retry-layer` in
 * [`failures.ts`](./failures.ts) covers which two writes need it and why nothing else does.
 */

import { isTransientDatabaseError } from '@gbd/db';

export type Sleep = (ms: number) => Promise<void>;

const SLEEP: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default waits: 250ms clears a connection re-establishment; 2s clears a fast failover. */
export const TRANSIENT_RETRY_WAITS_MS: readonly number[] = [250, 2_000];

export interface RetryOptions {
  /** What we were trying to do, for the log line: "Could not reach the database to <action>". */
  action: string;
  /** Structured context — entity IDs, etc. — logged next to the error. */
  context?: Record<string, unknown>;
  /** The wait before each retry, so there is always one more attempt than there are waits.
   *
   * Size these for *blips* — a reset pooled connection, one dropped packet. An outage outlasts any
   * bound worth putting here and is the caller's to handle.
   */
  waitsMs?: readonly number[];
  /** Injected by tests so no assertion waits on the wall clock. */
  sleep?: Sleep;
}

/** Run a database call again when the statement never completed, up to a small bound.
 *
 * Only transient database failures are retried. A statement Postgres refused meets the same
 * refusal every time; a blob store failure already retried inside `@gbd/storage`; and a
 * non-database error is not this function's to interpret — all three rethrow immediately.
 * After the last attempt, the transient error rethrows for the caller to classify.
 *
 * `fn` must run on the pool handle, never inside a caller's transaction: an aborted transaction
 * answers every retry with SQLSTATE 25P02, which is not transient, so the retry silently becomes
 * a no-retry. (The same constraint makes this unusable under `withRollback` in tests.)
 */
export async function retryOnTransientDbError<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const waits = options.waitsMs ?? TRANSIENT_RETRY_WAITS_MS;
  const sleep = options.sleep ?? SLEEP;
  const attempts = waits.length + 1;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (cause) {
      if (!isTransientDatabaseError(cause)) throw cause;
      console.error(
        `Could not reach the database to ${options.action} (attempt ${attempt} of ${attempts})`,
        { ...options.context, error: cause },
      );
      if (attempt === attempts) throw cause;
      await sleep(waits[attempt - 1] as number);
    }
  }
}
