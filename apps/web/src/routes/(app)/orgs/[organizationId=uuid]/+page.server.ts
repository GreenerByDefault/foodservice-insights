import type { AnalysisAttemptStatus, DatabaseExecutor, OrganizationId, ReportId } from '@gbd/db';
import { sql } from 'kysely';
import { screenStatus } from '$lib/reports/attempt-status';
import { newReportHref, reportHref } from '$lib/reports/hrefs';
import type { Creator } from '$lib/reports/subheading';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const organizationId = params.organizationId as OrganizationId;

  return await withDbErrorHandling(() => _loadReports(database(), { organizationId }), {
    action: "load an organization's reports",
    context: { organizationId },
  });
};

export type ReportListRow = {
  id: ReportId;
  href: string;
  name: string;
  siteName: string | null;
  creator: Creator;
  createdAt: Date;
  /** The screen status, not the raw column — see `screenStatus`. */
  status: AnalysisAttemptStatus;
  /** The database's clock, not the browser's — see `ReportPageData.now`. Carried per row rather
   * than once for the page because an empty list has no row to hang it off, and every row's
   * value is the same snapshot within one statement regardless. */
  now: Date;
};

export type ReportsPageData = {
  newReportHref: string;
  /** Newest upload first. */
  reports: ReportListRow[];
};

type ReportListRowQuery = {
  reportId: ReportId;
  reportName: string;
  siteName: string | null;
  reportCreatedAt: Date;
  creatorDisplayName: string | null;
  /** Null exactly when there is no joined user — see `_loadReport`'s `ReportRow`. */
  creatorEmail: string | null;
  status: AnalysisAttemptStatus;
  cancelRequestedAt: Date | null;
  now: Date;
};

/** Every report in an organization, newest upload first, for the dashboard/list page.
 *
 * Filters on `organizationId` and `deleted_at is null`. `report_organization_id_created_at`
 * covers the ordering but not the deletion filter, so that's a heap recheck rather than
 * index-covered.
 */
export async function _loadReports(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId },
): Promise<ReportsPageData> {
  const rows: ReportListRowQuery[] = await db
    .selectFrom((eb) =>
      eb
        .selectFrom('report')
        .innerJoin('analysisAttempt', 'analysisAttempt.reportId', 'report.id')
        // Left, not inner: `created_by_user_id` goes null on `ON DELETE SET NULL`, and a report
        // outlives the account that submitted it (see `_loadReport`).
        .leftJoin('appUser', 'appUser.id', 'report.createdByUserId')
        .leftJoin('auth.users', 'auth.users.id', 'appUser.id')
        .select([
          'report.id as reportId',
          'report.name as reportName',
          'report.siteName as siteName',
          'report.createdAt as reportCreatedAt',
          'appUser.displayName as creatorDisplayName',
          'auth.users.email as creatorEmail',
          'analysisAttempt.status as status',
          'analysisAttempt.cancelRequestedAt as cancelRequestedAt',
          // Selected alongside the row rather than as a separate query, so every row of one
          // response is one consistent snapshot — see `ReportListRow.now`.
          sql<Date>`now()`.as('now'),
        ])
        .where('report.organizationId', '=', params.organizationId)
        .where('report.deletedAt', 'is', null)
        // One row per report, keeping the latest attempt — safe because of the
        // `(report_id, attempt_number)` unique constraint. DISTINCT ON keeps this a single query
        // instead of the N+1 an `order by attempt_number desc limit 1` per report would become
        // at list scale; both forms hit `analysis_attempt_report_id_attempt_number` on its
        // leading column. Postgres requires DISTINCT ON's expression to lead ORDER BY, so the
        // report-level ordering happens in the outer query instead.
        .distinctOn('report.id')
        .orderBy('report.id')
        .orderBy('analysisAttempt.attemptNumber', 'desc')
        .as('latest'),
    )
    .selectAll()
    .orderBy('reportCreatedAt', 'desc')
    .execute();

  return {
    newReportHref: newReportHref(params.organizationId),
    reports: rows.map((row) => toReportListRow(params.organizationId, row)),
  };
}

function toReportListRow(organizationId: OrganizationId, row: ReportListRowQuery): ReportListRow {
  return {
    id: row.reportId,
    href: reportHref(organizationId, row.reportId),
    name: row.reportName,
    siteName: row.siteName,
    creator: row.creatorEmail
      ? { displayName: row.creatorDisplayName, email: row.creatorEmail }
      : null,
    createdAt: row.reportCreatedAt,
    status: screenStatus(row),
    now: row.now,
  };
}
