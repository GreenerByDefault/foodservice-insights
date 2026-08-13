/** What a database or blob store failure *means* in the worker.
 *
 * The web app answers an infrastructure failure with an HTTP status and is done
 * (`apps/web/src/lib/server/db.ts`); the worker has no response to shape, so each failure
 * becomes one of three things instead. The principles, resting on two architectural facts —
 * retrying an attempt is a user action, and the cross-worker reaper converges any attempt whose
 * lease expires ([`ARCHITECTURE.md`](../../../ARCHITECTURE.md#progress-leases-and-reaping)):
 *
 * 1. **An error is not a verdict.** A zero-row guarded update is the only "we lost the attempt".
 *    A *thrown* error means unknown ownership — never kill the child or write a verdict because
 *    of one. A failing lease-renewal write skips that tick, but never the local no-progress and
 *    hard-ceiling checks, which read the clock and the progress file rather than the database.
 * 2. **Loops retry by ticking; attempts fail terminally.** A failure in the claim poll or a
 *    supervise tick is logged and absorbed — the next tick is the retry. A failure while
 *    processing a *claimed* attempt becomes `failed('infrastructure')`, because a claimed
 *    attempt can never return to the queue.
 * 3. **The reaper is the backstop for a verdict we cannot record.** If even `finishFailed`
 *    cannot be written: kill the child first, log loudly, and abandon — and abandoning stops
 *    renewing the lease, or the row would stay `processing` forever and the reaper could never
 *    converge it.
 * 4. **Bounded retry only where one transient statement would otherwise terminally fail an
 *    attempt** — loading a claimed attempt's inputs, and the `finish*` writes, which record up
 *    to ~20 minutes of child work and real AI spend. Everything else already retries: the loops
 *    by ticking, and every blob store request inside the SDK (`MAX_ATTEMPTS` in
 *    `packages/storage/src/client.ts`). *Rejected: a second retry layer on blob calls — it would
 *    multiply the worst-case latency for no added coverage.*
 * 5. **A renewal asserts that the checks ran.** If the progress read throws — `EIO`, `ENOSPC`,
 *    a `ContractError` from a malformed `progress.json` — skip the renewal rather than treating a
 *    missing file (`ENOENT`, already mapped to `undefined`) the same as a read we could not
 *    trust. Renewing anyway would let one bad byte in `progress.json` produce a parent that
 *    renews forever and never evaluates a threshold. (A `ContractError` there is itself a
 *    *verdict*, `contract_violation` — not an absorbed tick error.)
 * 6. **Fencing.** Once the last successful renewal is older than the lease expiry, the parent
 *    must kill the child and stop, symmetrically with principle 1: the write fails ⇒ still run
 *    the checks; the checks cannot be evaluated ⇒ skip the write. Otherwise it keeps burning AI
 *    quota for up to `hardCeilingMs` and then discards a completed, fully-paid-for result on a
 *    zero-row update.
 */

import {
  type AnalysisFailureReason,
  isPermanentDatabaseError,
  isTransientDatabaseError,
} from '@gbd/db';
import { isBlobStoreError } from '@gbd/storage';

/** What to record in the database when an analysis fails due
 * to the parent's own machinery. */
export type AttemptFailure = {
  reason: Extract<AnalysisFailureReason, 'infrastructure' | 'unknown'>;
  detail: string;
};

/** Build the `AttemptFailure` for an error caught while processing a claimed attempt. */
export function classifyAttemptFailure(error: unknown): AttemptFailure {
  if (isTransientDatabaseError(error)) {
    return { reason: 'infrastructure', detail: `Could not reach the database: ${describe(error)}` };
  }
  if (isPermanentDatabaseError(error)) {
    return {
      reason: 'infrastructure',
      detail: `The database refused a statement (SQLSTATE ${error.code ?? 'unknown'}): ${error.message}`,
    };
  }
  if (isBlobStoreError(error)) {
    return {
      reason: 'infrastructure',
      detail: `Could not reach the blob store: ${describe(error)}`,
    };
  }
  return { reason: 'unknown', detail: describe(error) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Sleep = (ms: number) => Promise<void>;

const SLEEP: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default waits: 250ms clears a connection re-establishment; 2s clears a fast failover. */
export const TRANSIENT_RETRY_WAITS_MS: readonly number[] = [250, 2_000];

export interface RetryOptions {
  /** What we were trying to do, for the log line: "Could not reach the database to <action>". */
  action: string;
  /** Structured context — entity IDs, etc. — logged next to the error. */
  context?: Record<string, unknown>;
  /** The wait before each retry.
   *
   * The first attempt has no wait, so there is one more attempt than
   * there are waits.
   *
   * This layer bridges *blips* — a reset pooled connection, one dropped packet —
   * not outages, which are the caller's problem.
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
