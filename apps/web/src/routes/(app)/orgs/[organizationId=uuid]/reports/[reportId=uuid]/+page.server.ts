import {
  ANALYSIS_FAILURE_EXPLANATIONS,
  type AnalysisAttemptId,
  type AnalysisAttemptStatus,
  type AnalysisFailureReason,
  type DatabaseExecutor,
  type InputFileId,
  type OrganizationId,
  type ReportId,
  type ResultFileId,
  requireConstraint,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { UNEXPECTED_ERROR_MESSAGE } from '$lib/errors/messages';
import { database, withDbErrorHandling } from '$lib/server/db';
import { requireVar } from '$lib/server/env';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const reportId = params.reportId as ReportId;

  return await withDbErrorHandling(
    () =>
      _loadReport(database(), {
        organizationId,
        reportId,
        supportEmail: requireVar('EMAIL_SUPPORT_ADDRESS'),
      }),
    { action: 'load a report', context: { organizationId, reportId } },
  );
};

export type FileLink = { id: ResultFileId };
export type ChartLink = { id: ResultFileId; chartKey: string };

export type ResultFiles = {
  pdf: FileLink | null;
  xlsx: FileLink | null;
  charts: ChartLink[];
};

/** What we ask the user to do next, and what to say about it. */
export type FailureCopy = {
  whatHappened: string;
  followUpText: string;
  canRetry: boolean;
  contactMailto: string;
};

/** One report at one of its four reachable moments, plus `canceled`, which the union carries only
 * so the switch stays exhaustive. Canceling soft-deletes the report, so every query here already
 * filters `deleted_at is null` before a `canceled` attempt could ever be read back: the row this
 * page could show as canceled is a 404 from the moment it is requested.
 *
 * `claimedAt` is non-nullable on `processing`, and `finishedAt` non-nullable on every terminal
 * status, because the database already guarantees it: `analysis_attempt_processing_is_claimed`
 * and `analysis_attempt_finished_at_iff_terminal`. Asserting that once here means nothing
 * downstream has to handle a status paired with a missing timestamp that cannot actually occur.
 */
export type Attempt =
  | { status: 'pending'; createdAt: Date }
  | { status: 'processing'; createdAt: Date; claimedAt: Date }
  | { status: 'succeeded'; createdAt: Date; claimedAt: Date; finishedAt: Date; files: ResultFiles }
  | { status: 'failed'; finishedAt: Date; attemptNumber: number; failure: FailureCopy }
  | { status: 'canceled'; finishedAt: Date };

export type ReportPageData = {
  report: { id: ReportId; name: string };
  inputFile: { id: InputFileId; originalFilename: string; byteSize: number };
  attempt: Attempt;
};

type ReportRow = {
  reportId: ReportId;
  reportName: string;
  inputFileId: InputFileId;
  inputFileOriginalFilename: string;
  inputFileByteSize: number;
  attemptId: AnalysisAttemptId;
  attemptNumber: number;
  status: AnalysisAttemptStatus;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  failureReason: AnalysisFailureReason | null;
};

/** Everything the report page shows, for one report in one organization.
 *
 * Filters on the report id *and* the organization, and on `deleted_at is null`, so a report
 * belonging to someone else — or soft-deleted by a cancel — is a 404, not a leak.
 */
export async function _loadReport(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; supportEmail: string },
): Promise<ReportPageData> {
  // One query for the report, its input file and its latest attempt — `order by attempt_number
  // desc limit 1`, made safe by the `(report_id, attempt_number)` unique constraint. The result
  // file rows are deliberately not joined here: they cannot exist before the attempt succeeds,
  // and paying for that join on every ten-second poll to use it once, on success, is the wrong
  // trade.
  const row: ReportRow | undefined = await db
    .selectFrom('report')
    .innerJoin('inputFile', 'inputFile.reportId', 'report.id')
    .innerJoin('analysisAttempt', 'analysisAttempt.reportId', 'report.id')
    .select([
      'report.id as reportId',
      'report.name as reportName',
      'inputFile.id as inputFileId',
      'inputFile.originalFilename as inputFileOriginalFilename',
      'inputFile.byteSize as inputFileByteSize',
      'analysisAttempt.id as attemptId',
      'analysisAttempt.attemptNumber as attemptNumber',
      'analysisAttempt.status as status',
      'analysisAttempt.createdAt as createdAt',
      'analysisAttempt.claimedAt as claimedAt',
      'analysisAttempt.finishedAt as finishedAt',
      'analysisAttempt.failureReason as failureReason',
    ])
    .where('report.id', '=', params.reportId)
    .where('report.organizationId', '=', params.organizationId)
    .where('report.deletedAt', 'is', null)
    .orderBy('analysisAttempt.attemptNumber', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!row) return await failNotFoundOrBug(db, params);

  return {
    report: { id: row.reportId, name: row.reportName },
    inputFile: {
      id: row.inputFileId,
      originalFilename: row.inputFileOriginalFilename,
      byteSize: row.inputFileByteSize,
    },
    attempt: await toAttempt(db, row, params.supportEmail),
  };
}

/** The join found nothing. Distinguish "no such report" (404, the common case) from "the report
 * exists but has no attempt" — which one transaction creating `report`, `input_file` and the
 * first `analysis_attempt` together should make impossible. If it happens anyway, it is our bug,
 * not a 404: a report a user cannot see and a report we cannot render are different failures and
 * must not share a status code.
 */
async function failNotFoundOrBug(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId },
): Promise<never> {
  const reportExists = await db
    .selectFrom('report')
    .select('id')
    .where('id', '=', params.reportId)
    .where('organizationId', '=', params.organizationId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();

  if (!reportExists) error(404, { message: 'Not found', code: 'not_found' });

  console.error('A report has no analysis_attempt', { reportId: params.reportId });
  error(500, { message: UNEXPECTED_ERROR_MESSAGE });
}

async function toAttempt(
  db: DatabaseExecutor,
  row: ReportRow,
  supportEmail: string,
): Promise<Attempt> {
  switch (row.status) {
    case 'pending':
      return { status: 'pending', createdAt: row.createdAt };
    case 'processing':
      return {
        status: 'processing',
        createdAt: row.createdAt,
        claimedAt: requireConstraint(row.claimedAt, 'analysis_attempt_processing_is_claimed'),
      };
    case 'succeeded':
      return {
        status: 'succeeded',
        createdAt: row.createdAt,
        claimedAt: requireConstraint(row.claimedAt, 'analysis_attempt_processing_is_claimed'),
        finishedAt: requireConstraint(row.finishedAt, 'analysis_attempt_finished_at_iff_terminal'),
        files: await loadResultFiles(db, row.attemptId),
      };
    case 'failed':
      return {
        status: 'failed',
        finishedAt: requireConstraint(row.finishedAt, 'analysis_attempt_finished_at_iff_terminal'),
        attemptNumber: row.attemptNumber,
        failure: toFailureCopy(
          requireConstraint(row.failureReason, 'analysis_attempt_failure_reason_iff_failed'),
          supportEmail,
        ),
      };
    case 'canceled':
      return {
        status: 'canceled',
        finishedAt: requireConstraint(row.finishedAt, 'analysis_attempt_finished_at_iff_terminal'),
      };
  }
}

async function loadResultFiles(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
): Promise<ResultFiles> {
  // No other column orders the charts consistently within one attempt — `result_file.id` and
  // `created_at` are effectively identical for rows the worker inserts in one transaction — so
  // this is the one place that ordering is allowed to happen.
  const files = await db
    .selectFrom('resultFile')
    .select(['id', 'kind', 'chartKey'])
    .where('analysisAttemptId', '=', attemptId)
    .orderBy('chartKey')
    .execute();

  return {
    pdf: toFileLink(files.find((file) => file.kind === 'pdf')),
    xlsx: toFileLink(files.find((file) => file.kind === 'xlsx')),
    charts: files
      .filter((file) => file.kind === 'chart')
      .map((file) => ({
        id: file.id,
        chartKey: requireConstraint(file.chartKey, 'result_file_chart_key_iff_chart'),
      })),
  };
}

function toFileLink(file: { id: ResultFileId } | undefined): FileLink | null {
  return file ? { id: file.id } : null;
}

function toFailureCopy(reason: AnalysisFailureReason, supportEmail: string): FailureCopy {
  const explanation = ANALYSIS_FAILURE_EXPLANATIONS[reason];
  return {
    whatHappened: explanation.whatHappened,
    followUpText: explanation.followUp.text,
    canRetry: explanation.followUp.action === 'retry',
    contactMailto: `mailto:${supportEmail}`,
  };
}
