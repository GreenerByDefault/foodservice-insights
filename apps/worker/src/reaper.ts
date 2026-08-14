/** The reaping defense from [`ARCHITECTURE.md`](../../../ARCHITECTURE.md#progress-leases-and-reaping).
 *
 * **Placeholder — delete this paragraph once the supervision loop lands.** Nothing calls this on
 * an interval yet; `run()` is what owes it a `setInterval`-like sweep, via `sweep()`. Its only
 * caller until then is the test suite.
 *
 * **Open:** this only marks the row `failed('abandoned')`. Reaping also promises an email, which
 * waits on the email provider itself being chosen — see `ARCHITECTURE.md`'s Email row.
 */

import type {
  AnalysisAttemptId,
  AnalysisAttemptStatus,
  AnalysisFailureReason,
  Database,
  DatabaseExecutor,
  ReportId,
} from '@gbd/db';
import { type ExpressionBuilder, type RawBuilder, sql } from 'kysely';

export type ReapOptions = {
  /** How long the lease can go unrenewed before this reaper treats the owning parent as gone.
   *
   * Measured from the last renewal, not from when the attempt was first claimed — see
   * `claimedCeilingMs` for that.
   *
   * This is deliberately the same value the parent itself will fence on once it can no longer
   * renew. However, until the supervision loop lands, only the reaper uses it. */
  leaseExpiresAfterMs: number;

  /** How long an attempt can sit `processing` since it was claimed before this reaper gives up on
   * it, independent of renewals.
   *
   * `leaseExpiresAfterMs` can't catch a parent that renews forever but never finishes —
   * renewing is exactly what keeps it looking alive. This ceiling closes that gap: it fires on
   * elapsed time alone, so a parent that never stops renewing still eventually trips this ceiling. */
  claimedCeilingMs: number;

  /** The most expired attempts one call to `reapExpiredAttempts` will end.
   *
   * Naively, a botched deploy or an outage that takes down every worker at once could leave
   * the whole fleet's in-flight attempts stuck `processing` together. Reaping all of them in
   * one pass would fire off a burst of failure emails the moment the fleet comes back — one per
   * attempt, and enough of them at once risks tripping the email provider's own rate limiting or
   * abuse detection. So, this caps how many one call can send. */
  maxAttemptsPerSweep: number;

  /** Narrows the sweep to these reports.
   *
   * **Test isolation only; production passes nothing.** Same reasoning as `ClaimOptions` in
   * `queue.ts`: Turbo runs every package's tests concurrently against one database, so a reap
   * without it would end another test file's attempts.
   */
  candidateReports?: readonly ReportId[];
};

/** Two independent predicates, either of which condemns a `processing` attempt: a lease nobody is
 * renewing (the container died), or a claim held past the ceiling (the parent renews forever but
 * never finishes).
 *
 * Shared between the candidate subquery and the `UPDATE`'s own `WHERE`, so the two copies the query
 * needs cannot drift apart — see `reapExpiredAttempts` for why both have to exist at all.
 */
function isExpired(
  eb: ExpressionBuilder<Database, 'analysisAttempt'>,
  leaseExpiresBefore: RawBuilder<Date>,
  claimedBefore: RawBuilder<Date>,
) {
  return eb.or([
    eb('leaseRenewedAt', '<', leaseExpiresBefore),
    eb('claimedAt', '<', claimedBefore),
  ]);
}

function expiredCandidates(
  db: DatabaseExecutor,
  options: ReapOptions,
  leaseExpiresBefore: RawBuilder<Date>,
  claimedBefore: RawBuilder<Date>,
) {
  const candidates = db
    .selectFrom('analysisAttempt')
    .select('id')
    .where('status', '=', 'processing')
    .where((eb) => isExpired(eb, leaseExpiresBefore, claimedBefore))
    // Oldest-renewed first, so a sweep capped by `maxAttemptsPerSweep` converges on the
    // longest-abandoned attempts rather than an arbitrary subset. An attempt that trips only the
    // claimed ceiling has a fresh lease and so sorts last, behind every dead one — deliberate,
    // since a parent still renewing is still doing something.
    .orderBy('leaseRenewedAt')
    .limit(options.maxAttemptsPerSweep);

  return options.candidateReports === undefined
    ? candidates
    : candidates.where('reportId', 'in', options.candidateReports);
}

/** End every `processing` attempt this sweep is entitled to reap, in one `UPDATE`.
 *
 * **The expiry predicate is a top-level qual of the `UPDATE` itself.** Under READ COMMITTED, when
 * this statement's row lock request blocks on a row a concurrent renewal is committing, Postgres
 * re-evaluates that row's top-level `WHERE` against the version the renewal just committed once the
 * lock is released (`EvalPlanQual`) — so a renewal that lands while the reap waits makes the reap a
 * zero-row no-op for that row, and an attempt whose parent is demonstrably alive survives. This is
 * the load-bearing detail of the whole file.
 *
 * `EvalPlanQual` rechecks *only* that top-level qual. It does not re-evaluate the `IN` subplan, so a
 * candidate id list is stale however it was computed — whether by a preceding `SELECT` or by the
 * subquery below. Filtering only there and leaving the `UPDATE` to match on id would reap the live
 * attempt just as surely as a `SELECT`-then-`UPDATE` would. The predicate has to read
 * `lease_renewed_at`/`claimed_at` on the `UPDATE`, and no arrangement of subqueries substitutes.
 *
 * It appears in the subquery too, for a separate reason: Postgres `UPDATE` has no `ORDER BY` or
 * `LIMIT`, so choosing *which* expired attempts a capped sweep ends needs a subquery, and one that
 * did not filter would spend the cap on rows the `UPDATE` then discards.
 *
 * **Does not exclude its own `worker_id`.** A live parent kills its own children without the
 * database's help — for no progress, or for exceeding the total allowable time. This reaping
 * defends against the parent itself dying, leaving nothing to converge the rows it claimed. So the
 * filter could only ever matter where that reasoning has already failed — a parent alive but no
 * longer supervising — which is exactly when we want the reap. Reaping one of our own costs
 * nothing: the next `renewLease` returns `lost` and the supervision loop kills the child.
 */
export async function reapExpiredAttempts(
  db: DatabaseExecutor,
  workerId: string,
  options: ReapOptions,
): Promise<AnalysisAttemptId[]> {
  const leaseExpiresBefore = sql<Date>`now() - make_interval(secs => ${options.leaseExpiresAfterMs / 1000})`;
  const claimedBefore = sql<Date>`now() - make_interval(secs => ${options.claimedCeilingMs / 1000})`;

  const reaped = await db
    .updateTable('analysisAttempt')
    .set({
      // A cancellation request gets the truthful verdict and no failure email; everything else is
      // an abandoned attempt. `analysis_attempt_failure_reason_iff_failed` requires the two to move
      // together, so both branches are one expression rather than two separately-set columns.
      status: sql<AnalysisAttemptStatus>`(CASE WHEN cancel_requested_at IS NOT NULL THEN 'canceled' ELSE 'failed' END)::analysis_attempt_status`,
      failureReason: sql<AnalysisFailureReason | null>`(CASE WHEN cancel_requested_at IS NOT NULL THEN NULL ELSE 'abandoned' END)::analysis_failure_reason`,
      failureDetail: sql<string | null>`(CASE
        WHEN cancel_requested_at IS NOT NULL THEN NULL
        WHEN lease_renewed_at < ${leaseExpiresBefore} THEN 'lease not renewed since ' || lease_renewed_at
        ELSE 'claimed since ' || claimed_at || ' and never finished'
      END)`,
      finishedAt: sql<Date>`now()`,
      reapedByWorkerId: workerId,
    })
    .where('status', '=', 'processing')
    .where((eb) => isExpired(eb, leaseExpiresBefore, claimedBefore))
    .where('id', 'in', expiredCandidates(db, options, leaseExpiresBefore, claimedBefore))
    .returning('id')
    .execute();

  return reaped.map((row) => row.id);
}
