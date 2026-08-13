/** The worker's side of the analysis attempt queue: claim one, hold it, finish it.
 *
 * Every write here obeys the two rules the state machine imposes on any code that touches
 * `analysis_attempt.status`, documented in
 * [`@gbd/db`'s README](../../../packages/db/README.md#the-analysis-attempt-state-machine):
 *
 * 1. **A transition to a terminal status is one `UPDATE`.** Checks cannot be deferred, so
 *    `status`, `finished_at`, `failure_reason` and the `ai_*` columns are set together or the
 *    row is rejected part-way.
 * 2. **Terminal updates are guarded** by `status = 'processing' AND worker_id = $ours`. Losing
 *    the reaping race is then a zero-row update — a `false` return — rather than the
 *    `analysis_attempt_terminal_is_final` exception, which is the database's backstop for a
 *    statement that forgot the guard.
 *
 * Nothing here retries or requeues. Once an attempt leaves the queue it never returns to it:
 * retrying is a user action, per [`ARCHITECTURE.md`](../../../ARCHITECTURE.md#worker-queue).
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
import type { ChildResult, RunManifestInput } from './contract/messages.ts';

export type ClaimOptions = {
  /** Narrows the queue to attempts on these reports.
   *
   * **Test isolation only; production passes nothing.** Turbo runs every package's `test:unit`
   * concurrently against one database, so a worker that claimed globally would take attempts
   * belonging to another test file and fail it from the outside.
   *
   * **Open:** the shared test database is the real cause, and every queue-wide query the worker
   * grows — the cross-worker reaper first — will need the same parameter. A test database per
   * package would delete this one instead of spreading it.
   */
  candidateReports?: readonly ReportId[];
};

/** Take the oldest pending attempt, or `undefined` if there is nothing to take. The statement is
 * the one in [`ARCHITECTURE.md`](../../../ARCHITECTURE.md#worker-queue).
 */
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
      lockedAt: sql<Date>`now()`,
      lastHeartbeatAt: sql<Date>`now()`,
    })
    .where('id', '=', nextPendingAttempt(db, options.candidateReports))
    .returning('id')
    .executeTakeFirst();

  return claimed?.id;
}

function nextPendingAttempt(
  db: DatabaseExecutor,
  candidateReports: readonly ReportId[] | undefined,
) {
  const pending = db.selectFrom('analysisAttempt').select('id').where('status', '=', 'pending');

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

/** Everything spawning a child for an attempt needs: the manifest's contents, and the ids that
 * build the input file's storage key.
 */
export type AttemptInputs = {
  organizationId: OrganizationId;
  reportId: ReportId;
  /** The manifest's fields — `checksumSha256` is hex there, `bytea` in the column — plus the id
   * and key that fetch the object. */
  inputFile: RunManifestInput['inputFile'] & { id: InputFileId; storageKey: string };
  report: RunManifestInput['report'];
};

/** Throws if the attempt, its report, or its input file is missing. A claimed attempt has all
 * three — the foreign keys guarantee the first two, and the upload path writes the report and its
 * file in one transaction — so absence is corruption rather than a case to handle, and the caller
 * fails the attempt as `infrastructure`.
 */
export async function loadAttemptInputs(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
): Promise<AttemptInputs> {
  const row = await db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .innerJoin('inputFile', 'inputFile.reportId', 'report.id')
    // The two ids are aliased because the join has two of them; nothing else here collides.
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
      'inputFile.originalFilename',
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
      originalFilename: row.originalFilename,
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

/** `lost` means the attempt is no longer ours: another writer reached a verdict for it, or the
 * cross-worker reaper took it away. Either way there is nothing left for us to record. */
export type Heartbeat = { kind: 'held'; cancelRequestedAt: Date | null } | { kind: 'lost' };

/** One statement per attempt per supervision tick, answering both questions that tick has: do we
 * still own this attempt, and has someone asked for it to be canceled. Splitting them into a read
 * and a write would double the round trips and let the two answers disagree.
 */
export async function heartbeat(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
): Promise<Heartbeat> {
  const held = await db
    .updateTable('analysisAttempt')
    .set({ lastHeartbeatAt: sql<Date>`now()` })
    .where('id', '=', attemptId)
    .where('status', '=', 'processing')
    .where('workerId', '=', workerId)
    .returning('cancelRequestedAt')
    .executeTakeFirst();

  return held === undefined ? { kind: 'lost' } : { kind: 'held', ...held };
}

/** A result file that has already been uploaded, ready to be recorded.
 *
 * Built on `StoredFile` so that what `putResultFile` returns is what this takes, unmodified — the
 * content type recorded on the row is then the one the object was actually stored with. The union
 * is `result_file_chart_key_iff_chart` in the type system, so a chart with no key cannot be built
 * rather than being rejected by Postgres after the upload has already happened.
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
export async function finishSucceeded(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
  outcome: { result: ChildResult; resultFiles: readonly ResultFileRecord[] },
): Promise<boolean> {
  const { ai, resultMetadata } = outcome.result;

  return await withTransaction(db, async (transaction) => {
    // The guarded update goes first so that losing the race writes nothing at all: `result_file`
    // rows for an attempt whose verdict is someone else's would be results nothing points at.
    const won = await finishTerminal(transaction, attemptId, workerId, {
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
 * ambiguity as `finishSucceeded`'s: it can mean another writer's verdict stands, or that our own
 * first attempt already committed. */
export async function finishFailed(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
  failure: { reason: AnalysisFailureReason; detail: string | null },
): Promise<boolean> {
  return await finishTerminal(db, attemptId, workerId, {
    status: 'failed',
    failureReason: failure.reason,
    failureDetail: failure.detail,
  });
}

/** Returns whether we still owned the attempt. Same residual ambiguity under retry as
 * `finishSucceeded`'s. */
export async function finishCanceled(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
  workerId: string,
): Promise<boolean> {
  return await finishTerminal(db, attemptId, workerId, { status: 'canceled' });
}

type TerminalColumns = Updateable<Database['analysisAttempt']> & {
  status: 'succeeded' | 'failed' | 'canceled';
};

/** The one statement that ends an attempt. `finished_at` is set here rather than by each caller,
 * so rule 1 above cannot be broken by adding a fourth verdict.
 */
async function finishTerminal(
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
