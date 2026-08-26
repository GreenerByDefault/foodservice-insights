/** What a database or blob store failure *means* in the worker.
 *
 * The web app answers an infrastructure failure with an HTTP status and is done
 * (`apps/web/src/lib/server/db.ts`). The worker has no response to shape, so a failure here
 * becomes one of three things instead: absorbed by the loop that hit it, recorded as the failure
 * of the attempt that hit it, or abandoned for another worker to converge. The named rules below
 * decide which, and the rest of the package cites them by name.
 *
 * Two architectural facts hold all six up: retrying an attempt is a *user* action, so nothing here
 * may quietly re-run one; and the cross-worker reaper converges any attempt whose lease expires, so
 * letting go of an attempt is always safe
 * ([`ARCHITECTURE.md`](../../../ARCHITECTURE.md#progress-leases-and-reaping)).
 *
 * - **only-zero-rows-means-lost.** Losing an attempt has exactly one signal: a guarded update that
 *   matches no rows. A *thrown* error is not that signal — it leaves ownership exactly as unknown
 *   as it was — so no error may conclude that this attempt is gone, kill its child, or hand it to
 *   another worker. (An error can still fail an attempt we *do* still own; that is `absorb-or-fail`
 *   below, and it is a different question from this one.) A failing lease-renewal write therefore
 *   costs that tick its renewal and nothing else: the no-progress and hard-ceiling checks read the
 *   clock and the progress file, not the database, so they still run.
 * - **absorb-or-fail.** Loops retry by ticking; attempts fail terminally. A failure in the claim
 *   poll or a direct tick is logged and absorbed, because the next tick is already the retry. A
 *   failure while processing a *claimed* attempt becomes `failed('infrastructure')`, because a
 *   claimed attempt can never return to the queue and so has no next tick to wait for. The one
 *   exception is a claim statement Postgres *refuses*, which ticking will meet again unchanged:
 *   the worker drains and exits nonzero.
 * - **reaper-is-the-backstop** for a verdict we cannot record. When even `markAttemptFailed` will
 *   not go through, kill the child, log loudly, and abandon the attempt — and abandoning it means
 *   stopping the lease renewals too, or the row sits `processing` forever with nothing left alive
 *   to converge it.
 * - **one-retry-layer.** Every path retries in exactly one place, and this file is that place only
 *   where nothing else already is: loading a claimed attempt's inputs, and the `markAttempt*`
 *   writes. Those two are unrepeatable — they carry up to ~20 minutes of child work and real AI
 *   spend that a single dropped connection would otherwise throw away. Everywhere else the layer
 *   already exists: the loops retry by ticking, and every blob store request retries inside the
 *   SDK (`MAX_ATTEMPTS` in `packages/storage/src/client.ts`). *Rejected: a second layer on top of
 *   the blob calls — it multiplies the worst-case latency and covers nothing new.*
 * - **no-check-no-renewal.** A renewal tells the rest of the fleet that this parent just looked at
 *   its child, so it may only be issued by a tick that actually did. If the progress read throws —
 *   `EIO`, `ENOSPC`, a `ContractError` from a malformed `progress.json` — skip the renewal rather
 *   than treat an unreadable file the way we treat an absent one (`ENOENT`, already mapped to
 *   `undefined`). Renewing on a read we could not trust would let one bad byte in `progress.json`
 *   produce a parent that renews forever and evaluates nothing. Skipping the renewal does not
 *   suspend the clock-only checks, though: `fencing` is exactly what has to end such a child.
 *   (A `ContractError` there is itself a *verdict*, `contract_violation`, not an absorbed error.)
 * - **fencing.** Once the last successful renewal is older than the lease expiry, the parent must
 *   kill its child and stop. This is `only-zero-rows-means-lost` and `no-check-no-renewal` meeting
 *   from opposite sides — the write fails ⇒ still run the checks; the checks cannot be run ⇒ skip
 *   the write — and without it a
 *   parent burns AI quota for up to `killAfterTotalRuntimeMs` only to have its finished,
 *   fully-paid-for result discarded by a zero-row update.
 */

import {
  type AnalysisFailureReason,
  isPermanentDatabaseError,
  isTransientDatabaseError,
} from '@gbd/db';
import { isBlobStoreError } from '@gbd/storage';

/** What to record when an attempt fails through the parent's own machinery rather than through
 * anything the child did. */
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
