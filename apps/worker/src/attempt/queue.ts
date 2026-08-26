/** The worker's side of the analysis attempt queue: claim one, hold it, finish it.
 *
 * Every write here obeys the two rules the state machine imposes on any code that touches
 * `analysis_attempt.status`, documented in
 * [`@gbd/db`'s README](../../../../packages/db/README.md#the-analysis-attempt-state-machine):
 *
 * 1. **A transition to a terminal status is one `UPDATE`.** Checks cannot be deferred, so
 *    `status`, `finished_at`, `failure_reason` and the `ai_*` columns are set together or the
 *    row is rejected part-way.
 * 2. **Terminal updates are guarded** by `status = 'processing' AND worker_id = $ours`. Losing
 *    the reaping race is then a zero-row update — a `false` return — rather than the
 *    `analysis_attempt_terminal_is_final` exception, which is the database's backstop for a
 *    statement that forgot the guard.
 *
 * Nothing here retries or requeues. Once an attempt leaves the queue it never returns to it.
 * Users initiate retrying an analysis_attempt.
 */

import type {
  AnalysisAttemptId,
  AnalysisFailureReason,
  Database,
  DatabaseExecutor,
  InputFileId,
  OrganizationId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';
import { withTransaction } from '@gbd/db';
import type { StoredFile } from '@gbd/storage';
import { sql, type Updateable } from 'kysely';
import type { ChildResult, RunManifestInput } from '../contract/messages.ts';

// -----------------------------------------------------
// Claiming
// -----------------------------------------------------

export type ClaimOptions = {
  /** Narrows the queue to attempts on these reports.
   *
   * **Test isolation only; production passes nothing.** Turbo runs every package's `test:unit`
   * concurrently against one database, so a worker that claimed globally would take attempts
   * belonging to another test file and fail it from the outside.
   */
  candidateReports?: readonly ReportId[];
};

/** Take the oldest pending attempt, or `undefined` if there is nothing to take. */
export async function claimNextAttempt(
  db: DatabaseExecutor,
  workerId: string,
  options: ClaimOptions = {},
): Promise<AnalysisAttemptId | undefined> {
  const claimed = await db
    .updateTable('analysisAttempt')
    .set({
      status: 'processing',
      workerId,
      claimedAt: sql<Date>`now()`,
      leaseRenewedAt: sql<Date>`now()`,
    })
    .where('id', '=', nextPendingAttempt(db, options.candidateReports))
    .returning('id')
    .executeTakeFirst();

  return claimed?.id;
}

/** Get the oldest pending attempt not already cancel-requested. Locked for update.
 *
 * A cancel request on an unclaimed row means there is nothing to start — see
 * `cancelRequestedPendingAttempts` in `reaper.ts` for who converges it to `canceled`.
 */
function nextPendingAttempt(
  db: DatabaseExecutor,
  candidateReports: readonly ReportId[] | undefined,
) {
  const pending = db
    .selectFrom('analysisAttempt')
    .select('id')
    .where('status', '=', 'pending')
    // No `EvalPlanQual` double-predicate here, unlike `reaper.ts`'s expiry sweep: `forUpdate` +
    // `skipLocked` below make the single copy sufficient. A row a concurrent cancel holds locked
    // is *skipped* rather than waited on, and a row whose cancel already committed is re-read at
    // its new version once the lock is taken, so this predicate excludes it either way — the
    // claim never selects a row it would then have to re-check.
    .where('cancelRequestedAt', 'is', null);

  return (
    (candidateReports === undefined ? pending : pending.where('reportId', 'in', candidateReports))
      .orderBy('createdAt')
      .forUpdate()
      // The whole of the concurrency control: a second worker steps over the row this one holds
      // rather than queueing behind it, so a busy queue never blocks a claim.
      .skipLocked()
      .limit(1)
  );
}

// -----------------------------------------------------
// Loading attempt inputs
// -----------------------------------------------------

export type AttemptInputs = {
  organizationId: OrganizationId;
  reportId: ReportId;
  inputFile: {
    id: InputFileId;
    storageKey: string;
    byteSize: number;
    checksumSha256: string;
  };
  report: RunManifestInput['report'];
};

/** Throws if the attempt, its report, or its input file is missing, which would be unexpected. */
export async function loadAttemptInputs(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
): Promise<AttemptInputs> {
  const row = await db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .innerJoin('inputFile', 'inputFile.reportId', 'report.id')
    .select([
      'report.id as reportId',
      'inputFile.id as inputFileId',
      'report.organizationId',
      'report.name',
      'report.siteName',
      'report.countsBasis',
      'report.unitSystem',
      'report.monthlyCounts',
      'inputFile.storageKey',
      'inputFile.byteSize',
      'inputFile.checksumSha256',
    ])
    .where('analysisAttempt.id', '=', attemptId)
    .executeTakeFirstOrThrow();

  return {
    organizationId: row.organizationId,
    reportId: row.reportId,
    inputFile: {
      id: row.inputFileId,
      storageKey: row.storageKey,
      byteSize: row.byteSize,
      checksumSha256: (row.checksumSha256 as Buffer).toString('hex'),
    },
    report: {
      name: row.name,
      siteName: row.siteName,
      countsBasis: row.countsBasis,
      unitSystem: row.unitSystem,
      monthlyCounts: row.monthlyCounts,
    },
  };
}

// -----------------------------------------------------
// Lease renewal
// -----------------------------------------------------

/** `lost` means the attempt is no longer ours: another writer reached a verdict for it, or the
 * cross-worker reaper took it away. Either way there is nothing left for us to record. */
export type Lease = { kind: 'held'; cancelRequestedAt: Date | null } | { kind: 'lost' };

/** One statement per attempt per direct tick, answering both questions that tick has: do we
 * still own this attempt, and has someone asked for it to be canceled.
 */
export async function renewLease(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
): Promise<Lease> {
  const held = await db
    .updateTable('analysisAttempt')
    .set({ leaseRenewedAt: sql<Date>`now()` })
    .where('id', '=', attemptId)
    .where('status', '=', 'processing')
    .where('workerId', '=', workerId)
    .returning('cancelRequestedAt')
    .executeTakeFirst();

  return held === undefined ? { kind: 'lost' } : { kind: 'held', ...held };
}

// -----------------------------------------------------
// Finishing attempts
// -----------------------------------------------------

/** A result file that has already been uploaded, ready to be recorded.
 *
 * Built on `StoredFile` so that what `putResultFile` returns is what this takes, unmodified — the
 * content type recorded on the row is then the one the object was actually stored with.
 */
export type ResultFileRecord = StoredFile & {
  /** Minted by the caller, because the storage key is built from it before the upload. */
  id: ResultFileId;
} & ({ kind: 'chart'; chartKey: string } | { kind: Exclude<ResultFileKind, 'chart'> });

/** Record a successful attempt and the files it produced. Returns whether we still owned it.
 *
 * The guarded update doubles as the retry idempotency key: if the COMMIT lands but its ack is
 * lost to a transient error and `retryOnTransientDbError` calls this again, the retry's UPDATE
 * matches zero rows — the first call already moved `status` off `processing` — and returns
 * `false` before it can insert `result_file` a second time. Under that retry, `false` can
 * therefore mean either "another writer reached a verdict first" or "our own first attempt
 * already committed"; the data is correct either way, and a `status, worker_id` read-back would
 * disambiguate the two if a consumer (the deferred email) ever needs to.
 */
export async function markAttemptSucceeded(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
  outcome: { result: ChildResult; resultFiles: readonly ResultFileRecord[] },
): Promise<boolean> {
  const { ai, resultMetadata } = outcome.result;

  return await withTransaction(db, async (transaction) => {
    // The guarded update goes first so that losing the race writes nothing at all: `result_file`
    // rows for an attempt whose verdict is someone else's would be results nothing points at.
    const won = await markIfStillOwned(transaction, attemptId, workerId, {
      status: 'succeeded',
      aiModel: ai.model,
      aiInputTokens: ai.inputTokens,
      aiOutputTokens: ai.outputTokens,
      // Stays the string the child sent, all the way to the column: `ai_cost_usd` is
      // `numeric(10,4)`, which float64 cannot round-trip.
      aiCostUsd: ai.costUsd,
      aiMetadata: ai.metadata,
      resultMetadata,
    });
    if (!won) return false;

    if (outcome.resultFiles.length > 0) {
      await transaction
        .insertInto('resultFile')
        .values(
          outcome.resultFiles.map((file) => ({
            ...file,
            analysisAttemptId: attemptId,
            chartKey: file.kind === 'chart' ? file.chartKey : null,
          })),
        )
        .execute();
    }
    return true;
  });
}

/** Returns whether we still owned the attempt. `false` under retry has the same residual
 * ambiguity as `markAttemptSucceeded`'s: it can mean another writer's verdict stands, or that our own
 * first attempt already committed. */
export async function markAttemptFailed(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
  failure: { reason: AnalysisFailureReason; detail: string | null },
): Promise<boolean> {
  return await markIfStillOwned(db, attemptId, workerId, {
    status: 'failed',
    failureReason: failure.reason,
    failureDetail: failure.detail,
  });
}

/** Returns whether we still owned the attempt. Same residual ambiguity under retry as
 * `markAttemptSucceeded`'s. */
export async function markAttemptCanceled(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
): Promise<boolean> {
  return await markIfStillOwned(db, attemptId, workerId, { status: 'canceled' });
}

type TerminalColumns = Updateable<Database['analysisAttempt']> & {
  status: 'succeeded' | 'failed' | 'canceled';
};

/** The one statement that ends an attempt. `finished_at` is set here rather than by each caller,
 * so rule 1 above cannot be broken by adding a fourth verdict.
 *
 * Guarded by `worker_id`, not staleness — this is the *owning* worker recording its own verdict.
 * The reaper ends an attempt it never claimed, so it writes a separate statement with a
 * different guard rather than calling this one.
 *
 * **Deliberately not guarded on `cancel_requested_at`.** A cancel is honoured by killing the child;
 * one that finished first has already done the work, and discarding a report we are holding serves
 * nobody. So a terminal row can carry a non-null `cancel_requested_at`, and readers have to let the
 * status win.
 */
async function markIfStillOwned(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
  columns: TerminalColumns,
): Promise<boolean> {
  const updated = await db
    .updateTable('analysisAttempt')
    .set({ ...columns, finishedAt: sql<Date>`now()` })
    .where('id', '=', attemptId)
    .where('status', '=', 'processing')
    .where('workerId', '=', workerId)
    .executeTakeFirst();

  return updated.numUpdatedRows === 1n;
}
