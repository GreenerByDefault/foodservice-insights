/** Two sweeps, each converging a row nothing else will finish: `reapExpiredAttempts` for an
 * expired `processing` attempt (the reaping defense from
 * [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md#progress-leases-and-reaping)), and
 * `cancelRequestedPendingAttempts` for a `pending` attempt somebody has asked to cancel. */

import type {
  AnalysisAttemptId,
  AnalysisAttemptStatus,
  AnalysisFailureReason,
  Database,
  DatabaseExecutor,
  ReportId,
} from '@gbd/db';
import { type ExpressionBuilder, type RawBuilder, sql } from 'kysely';
import type { WorkerConfig } from '../config.ts';
import { msAgo } from '../sql.ts';

export type ReapOptions = Pick<
  WorkerConfig,
  'leaseExpiresAfterMs' | 'claimedCeilingMs' | 'maxReapsPerSweep'
> & {
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
    // Oldest-renewed first, so a sweep capped by `maxReapsPerSweep` converges on the
    // longest-abandoned attempts rather than an arbitrary subset. An attempt that trips only the
    // claimed ceiling has a fresh lease and so sorts last, behind every dead one — deliberate,
    // since a parent still renewing is still doing something.
    .orderBy('leaseRenewedAt')
    .limit(options.maxReapsPerSweep);

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
 * `EvalPlanQual`'s recheck reruns the plan for the one row that blocked, but pins every other
 * relation the plan touches to the exact rows it joined the first time, refetched by row identity
 * rather than recomputed. That includes whatever produces the `IN`'s candidate ids, however
 * Postgres plans that. That candidate id list, then, is fixed once, before the wait, and stays
 * fixed after — whether it comes from a preceding `SELECT` or the subquery below makes no
 * difference. That's why the expiry predicate has to be repeated as its own top-level qual on the
 * `UPDATE`, and filtering it into the id list is not equivalent: if the `UPDATE`'s own top-level
 * `WHERE` matched only on those ids, a row that stopped being expired during the wait would still
 * match by id and get reaped, however that id list is produced.
 *
 * The subquery also repeats the predicate for an unrelated, non-correctness reason. Postgres
 * `UPDATE` has no `ORDER BY` or `LIMIT`, so the subquery is what decides which expired attempts a
 * capped sweep spends its `maxReapsPerSweep` on. If the subquery instead filtered only on
 * `status = 'processing'`, its `LIMIT`-sized batch could include fresh, unexpired rows. The
 * `UPDATE`'s own expiry check would then discard those, spending the cap before a genuinely
 * expired row further down the order got a turn. That failure would be narrower than the one
 * above — the sweep would return fewer reaps than its cap allowed, never one it shouldn't have
 * made — but it is why the subquery repeats the predicate too.
 *
 * **Does not exclude its own `worker_id`.** A live parent kills its own children without the
 * database's help — for no progress, or for exceeding the total allowable time. This reaping
 * defends against the parent itself dying, leaving nothing to converge the rows it claimed. So the
 * filter could only ever matter where that reasoning has already failed — a parent alive but no
 * longer directing — which is exactly when we want the reap. Reaping one of our own costs
 * nothing: the next `renewLease` returns `lost` and the direct loop kills the child.
 */
export async function reapExpiredAttempts(
  db: DatabaseExecutor,
  workerId: string,
  options: ReapOptions,
): Promise<AnalysisAttemptId[]> {
  const leaseExpiresBefore = msAgo(options.leaseExpiresAfterMs);
  const claimedBefore = msAgo(options.claimedCeilingMs);

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
      // A reap can legitimately end a row whose `lease_renewed_at` is newer than its own `now()`.
      // That happens when a renewal starts after this statement does and commits while it waits
      // for that row's lock. Under the ceiling, `EvalPlanQual` above condemns the row anyway.
      //
      // A bare `now()` would then violate `analysis_attempt_finished_at_after_lease_renewed`. A
      // check violation aborts the whole statement, so that one row would take the rest of the
      // sweep down with it.
      finishedAt: sql<Date>`greatest(now(), lease_renewed_at)`,
      reapedByWorkerId: workerId,
    })
    .where('status', '=', 'processing')
    .where((eb) => isExpired(eb, leaseExpiresBefore, claimedBefore))
    .where('id', 'in', expiredCandidates(db, options, leaseExpiresBefore, claimedBefore))
    .returning('id')
    .execute();

  return reaped.map((row) => row.id);
}

export type CancelSweepOptions = {
  /** Narrows the sweep to these reports. Test isolation only; see `ReapOptions.candidateReports`. */
  candidateReports?: readonly ReportId[];
};

/** End every `pending` attempt somebody has asked to cancel.
 *
 * Three things this deliberately does *not* have, each present in `reapExpiredAttempts`:
 *
 * - **No `workerId`.** A `pending` row has no owner, so there is nobody to take it from and
 *   `reaped_by_worker_id` would be a lie.
 * - **No expiry predicate, and no repeated top-level qual.** The race `reapExpiredAttempts` guards
 *   against with `EvalPlanQual` is a lease renewal landing while the reap waits; the only competing
 *   writer here is a claim, and `status = 'pending'` as a top-level qual already handles it. If the
 *   claim commits first, the recheck sees `processing` and this is a zero-row no-op, leaving the
 *   row to the parent, which will see the request on its very next renewal. If this commits first,
 *   the claim's `SKIP LOCKED` scan re-reads the row and its new predicate excludes it.
 * - **No `maxReapsPerSweep`.** That cap bounds a burst of failure emails; a canceled attempt is
 *   never emailed — `notifications.ts`'s `status <> 'canceled'`, and
 *   `analysis_attempt_canceled_is_not_notified` behind it.
 *
 * `finished_at = now()` is safe on a `pending` row: `analysis_attempt_finished_at_after_lease_renewed`
 * tolerates a NULL `lease_renewed_at`, and `worker_id` stays NULL because
 * `analysis_attempt_processing_is_claimed` only constrains `processing`.
 */
export async function cancelRequestedPendingAttempts(
  db: DatabaseExecutor,
  options: CancelSweepOptions,
): Promise<AnalysisAttemptId[]> {
  const converged = await db
    .updateTable('analysisAttempt')
    .set({ status: 'canceled', finishedAt: sql<Date>`now()` })
    .where('status', '=', 'pending')
    .where('cancelRequestedAt', 'is not', null)
    .$if(options.candidateReports !== undefined, (qb) =>
      qb.where('reportId', 'in', options.candidateReports ?? []),
    )
    .returning('id')
    .execute();

  return converged.map((row) => row.id);
}
