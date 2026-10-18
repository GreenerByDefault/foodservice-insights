import type { RawBuilder } from 'kysely';
import type { UsersId } from '../../generated/auth/Users.ts';
import type { AnalysisAttempt, AnalysisAttemptId } from '../../generated/public/AnalysisAttempt.ts';
import type {
  AnalysisAttemptFinding,
  NewAnalysisAttemptFinding,
} from '../../generated/public/AnalysisAttemptFinding.ts';
import type AnalysisAttemptStatus from '../../generated/public/AnalysisAttemptStatus.ts';
import type AnalysisFailureReason from '../../generated/public/AnalysisFailureReason.ts';
import type { AppUser } from '../../generated/public/AppUser.ts';
import type { Organization } from '../../generated/public/Organization.ts';
import type { Report } from '../../generated/public/Report.ts';
import type { ResultFile } from '../../generated/public/ResultFile.ts';
import type ResultFileKind from '../../generated/public/ResultFileKind.ts';
import type { DatabaseExecutor } from '../../schema.ts';
import { insertReport } from './report.ts';
import { aChecksum, DB_NOW } from './values.ts';

/** An attempt in `status`, with whatever other columns make it a state the app can actually
 * produce:
 * - `finished_at` for any terminal status.
 * - `worker_id`/`claimed_at`/`lease_renewed_at` for `processing`, `succeeded`, and `failed` —
 *   reaching one of those means the worker claimed the attempt first. The CHECK constraints
 *   don't require this; the state machine does.
 * - `canceled` is the exception: `ARCHITECTURE.md` § Canceling allows canceling a `pending`
 *   attempt that was never claimed.
 *
 * See `analysis_attempt` in public-schema.sql for the constraints themselves.
 */
export async function insertAnalysisAttempt(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    attemptNumber?: number;
    status?: AnalysisAttemptStatus;
    workerId?: string;
    requestedByUserId?: UsersId | null;
    createdAt?: Date | RawBuilder<Date>;
    /** Only meaningful for `processing`, `succeeded`, and `failed` — the statuses a claim implies.
     * Defaults to `finishedAt` so a terminal row's claim and finish line up without repeating the
     * timestamp; set this explicitly to backdate a claim on a `processing` row, which has no
     * `finishedAt` of its own. */
    claimedAt?: Date | RawBuilder<Date>;
    /** Only meaningful for a terminal `status` — once inserted, `analysis_attempt_terminal_is_final`
     * forbids ever moving this by `UPDATE`, so a backdated terminal row has to be born that way. */
    finishedAt?: Date | RawBuilder<Date>;
    /** Defaults to `DB_NOW` for `status: 'canceled'`, since `analysis_attempt_canceled_requires_request`
     * forbids a canceled row with no request. Set explicitly for a `pending`/`processing` row a test
     * wants to look like a cancel request has already landed on — pass `DB_NOW`/`dbMsAgo(ms)` rather than
     * `new Date()`/`msAgo(ms)` unless the test needs a specific value. */
    cancelRequestedAt?: Date | RawBuilder<Date>;
    /** Only meaningful for `status: 'failed'` — `analysis_attempt_failure_reason_iff_failed` requires
     * one there and forbids one everywhere else. Defaults to `'child_crashed'`, an arbitrary member of
     * `analysis_failure_reason`; set this to exercise a specific reason's copy. */
    failureReason?: AnalysisFailureReason;
    /** Defaults to 1. Set higher to build a row an older worker must leave in the queue. */
    requiredContractVersion?: number;
  } = {},
): Promise<AnalysisAttempt> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;
  const status = overrides.status ?? 'pending';

  const isClaimed = status === 'processing' || status === 'succeeded' || status === 'failed';
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'canceled';
  const isCanceled = status === 'canceled';

  return await database
    .insertInto('analysisAttempt')
    .values({
      reportId,
      attemptNumber: overrides.attemptNumber ?? 1,
      status,
      requestedByUserId: overrides.requestedByUserId ?? null,
      requiredContractVersion: overrides.requiredContractVersion ?? 1,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      // A backdated finishedAt still has to satisfy analysis_attempt_finished_at_after_lease_renewed,
      // so a claim added on the caller's behalf must not be later than it — hence claimedAt falling
      // back to finishedAt when the caller only backdated the finish.
      ...(isClaimed
        ? {
            workerId: overrides.workerId ?? 'test-worker',
            claimedAt: overrides.claimedAt ?? overrides.finishedAt ?? DB_NOW,
            leaseRenewedAt: overrides.claimedAt ?? overrides.finishedAt ?? DB_NOW,
          }
        : {}),
      ...(isTerminal
        ? {
            finishedAt: overrides.finishedAt ?? DB_NOW,
            failureReason:
              status === 'failed' ? (overrides.failureReason ?? 'child_crashed') : null,
          }
        : {}),
      ...(overrides.cancelRequestedAt !== undefined
        ? { cancelRequestedAt: overrides.cancelRequestedAt }
        : isCanceled
          ? { cancelRequestedAt: DB_NOW }
          : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A report and the one attempt on it, for a test about acting on a report rather than about
 * either row's own constraints. Defaults to `pending` — the state a report just submitted is in,
 * and the one an action like canceling or deleting has something to do about.
 */
export async function insertReportWithAttempt(
  database: DatabaseExecutor,
  overrides: {
    organizationId?: Organization['id'];
    createdByUserId?: AppUser['id'] | null;
    requestedByUserId?: AppUser['id'] | null;
    status?: AnalysisAttemptStatus;
  } = {},
): Promise<{ report: Report; attempt: AnalysisAttempt }> {
  const report = await insertReport(database, {
    organizationId: overrides.organizationId,
    createdByUserId: overrides.createdByUserId ?? null,
  });
  const attempt = await insertAnalysisAttempt(database, {
    reportId: report.id,
    status: overrides.status ?? 'pending',
    requestedByUserId: overrides.requestedByUserId,
  });
  return { report, attempt };
}

export async function readAnalysisAttemptRow(
  database: DatabaseExecutor,
  attemptId: AnalysisAttempt['id'],
): Promise<AnalysisAttempt> {
  return await database
    .selectFrom('analysisAttempt')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
}

const RESULT_FILE_TEST_CONTENT_TYPE: Record<ResultFileKind, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export async function insertResultFile(
  database: DatabaseExecutor,
  overrides: {
    analysisAttemptId?: AnalysisAttempt['id'];
    kind?: ResultFileKind;
    storageKey?: string;
  } = {},
): Promise<ResultFile> {
  const analysisAttemptId =
    overrides.analysisAttemptId ?? (await insertAnalysisAttempt(database)).id;
  const kind = overrides.kind ?? 'pdf';

  return await database
    .insertInto('resultFile')
    .values({
      analysisAttemptId,
      kind,
      storageKey: overrides.storageKey ?? `org/test/${crypto.randomUUID()}.${kind}`,
      byteSize: 1024,
      contentType: RESULT_FILE_TEST_CONTENT_TYPE[kind],
      checksumSha256: aChecksum(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertAnalysisAttemptFinding(
  database: DatabaseExecutor,
  analysisAttemptId: AnalysisAttemptId,
  overrides: Partial<Omit<NewAnalysisAttemptFinding, 'analysisAttemptId'>> = {},
): Promise<AnalysisAttemptFinding> {
  return await database
    .insertInto('analysisAttemptFinding')
    .values({
      position: 0,
      qualityCheck: 'missing_internal_months',
      status: 'warning',
      message: 'No lines were found for Feb 2024.',
      sampleValues: ['Feb 2024'],
      ...overrides,
      analysisAttemptId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
