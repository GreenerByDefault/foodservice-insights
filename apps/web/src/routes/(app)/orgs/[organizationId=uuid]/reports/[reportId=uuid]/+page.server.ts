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
import { sql } from 'kysely';
import { UNEXPECTED_ERROR_MESSAGE } from '$lib/errors/messages';
import { reportDependencyKey } from '$lib/reports/report-dependency';
import { database, withDbErrorHandling } from '$lib/server/db';
import { requireVar } from '$lib/server/env';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, depends }) => {
  const organizationId = params.organizationId as OrganizationId;
  const reportId = params.reportId as ReportId;

  // This allows client actions to use `invalidate()` to reload the page.
  depends(reportDependencyKey(reportId));

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

export type FileLink = { href: string };
export type ChartLink = { href: string; chartKey: string };

export type ResultFiles = {
  pdf: FileLink;
  xlsx: FileLink;
  charts: ChartLink[];
};

/** What we ask the user to do next, and what to say about it. */
export type FailureCopy = {
  whatHappened: string;
  followUpText: string;
  canRetry: boolean;
  contactMailto: string;
};

/** One report at one of its five reachable moments. `status` is the *screen*, not the column:
 * they agree except for a cancel the worker hasn't converged on yet, which shows as `canceled`
 * (see `toAttempt`).
 *
 * `claimedAt`/`finishedAt` are non-nullable where the DB guarantees them
 * (`analysis_attempt_processing_is_claimed`, `analysis_attempt_finished_at_iff_terminal`), so
 * nothing downstream handles a status paired with a timestamp that can't be missing.
 *
 * `canceled` carries `cancelRequestedAt` rather than `finishedAt`: it's the only timestamp
 * non-null on both branches this screen is reached from, and the more meaningful one to show.
 */
export type Attempt =
  | { status: 'pending'; createdAt: Date }
  | { status: 'processing'; createdAt: Date; claimedAt: Date }
  | { status: 'succeeded'; createdAt: Date; claimedAt: Date; finishedAt: Date; files: ResultFiles }
  | { status: 'failed'; finishedAt: Date; attemptNumber: number; failure: FailureCopy }
  | { status: 'canceled'; stoppedAt: Date };

export type ReportPageData = {
  report: { id: ReportId; name: string };
  cancelButtonHref: string;
  newReportHref: string;
  inputFile: { href: string; originalFilename: string; byteSize: number };
  attempt: Attempt;
  /** The database's clock, not the browser's — every duration on the page is `now - timestamp`
   * against this, so it is immune to clock skew and never mismatches between server and client
   * render (see `describeProgress`). */
  now: Date;
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
  cancelRequestedAt: Date | null;
  failureReason: AnalysisFailureReason | null;
  now: Date;
};

/** Everything the report page shows, for one report in one organization.
 *
 * Filters on report id, organization id, and `deleted_at is null` — so someone else's report,
 * or a deleted one, 404s instead of leaking. Canceled reports stay visible.
 */
export async function _loadReport(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; supportEmail: string },
): Promise<ReportPageData> {
  // Latest attempt via `order by attempt_number desc limit 1`, safe because of the
  // `(report_id, attempt_number)` unique constraint. Result files aren't joined here — they
  // only exist once an attempt succeeds, so paying for the join on every poll to use it once
  // is the wrong trade.
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
      'analysisAttempt.cancelRequestedAt as cancelRequestedAt',
      'analysisAttempt.failureReason as failureReason',
      // Selected alongside the row rather than as a separate query, so it's one consistent
      // snapshot — see `ReportPageData.now`.
      sql<Date>`now()`.as('now'),
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
    cancelButtonHref: `/api/orgs/${params.organizationId}/reports/${row.reportId}/cancel`,
    newReportHref: `/orgs/${params.organizationId}/reports/new`,
    inputFile: {
      href: `/file/input/${row.inputFileId}`,
      originalFilename: row.inputFileOriginalFilename,
      byteSize: row.inputFileByteSize,
    },
    attempt: await toAttempt(db, row, params.supportEmail),
    now: row.now,
  };
}

/** The join found nothing. A report with no attempt should be impossible — one transaction
 * creates `report`, `input_file` and the first `analysis_attempt` together — so distinguish
 * "no such report" (404) from that invariant being violated (our bug, 500).
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
  // We allow requests that were cancelled but still succeeded or failed to pass through.
  if (row.cancelRequestedAt !== null && (row.status === 'pending' || row.status === 'processing')) {
    return { status: 'canceled', stoppedAt: row.cancelRequestedAt };
  }

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
        stoppedAt: requireConstraint(
          row.cancelRequestedAt,
          'analysis_attempt_canceled_requires_request',
        ),
      };
  }
}

async function loadResultFiles(
  db: DatabaseExecutor,
  attemptId: AnalysisAttemptId,
): Promise<ResultFiles> {
  const files = await db
    .selectFrom('resultFile')
    .select(['id', 'kind', 'chartKey'])
    .where('analysisAttemptId', '=', attemptId)
    // Ensure a consistent order.
    .orderBy('chartKey')
    .execute();

  return {
    pdf: toFileLink(
      requireConstraint(
        files.find((file) => file.kind === 'pdf') ?? null,
        'analysis_attempt_succeeded_has_pdf',
      ),
    ),
    xlsx: toFileLink(
      requireConstraint(
        files.find((file) => file.kind === 'xlsx') ?? null,
        'analysis_attempt_succeeded_has_xlsx',
      ),
    ),
    charts: files
      .filter((file) => file.kind === 'chart')
      .map((file) => ({
        href: resultFileHref(file.id),
        chartKey: requireConstraint(file.chartKey, 'result_file_chart_key_iff_chart'),
      })),
  };
}

function toFileLink(file: { id: ResultFileId }): FileLink {
  return { href: resultFileHref(file.id) };
}

function resultFileHref(id: ResultFileId): string {
  return `/file/result/${id}`;
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
