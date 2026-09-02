import type { AnalysisAttemptStatus, DatabaseExecutor, OrganizationId, ReportId } from '@gbd/db';
import { sql } from 'kysely';
import { screenStatus } from '$lib/reports/attempt-status';
import { newerReportsHref, newReportHref, olderReportsHref, reportHref } from '$lib/reports/hrefs';
import type { Creator } from '$lib/reports/subheading';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';
import { parseCursor, type ReportsCursor } from './pagination.ts';

export const load: PageServerLoad = async ({ params, url }) => {
  const organizationId = params.organizationId as OrganizationId;
  const cursor = parseCursor(url.searchParams);

  return await withDbErrorHandling(() => _loadReports(database(), { organizationId, cursor }), {
    action: "load an organization's reports",
    context: { organizationId },
  });
};

/** How many reports one page of the list shows. Matches `WEEKLY_REPORT_LIMIT`, so a full page is
 * roughly a week of maximum use. */
export const _REPORTS_PAGE_SIZE = 20;

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
  /** Set only when a page of older reports exists — see `pagination.ts`. */
  olderHref: string | null;
  /** Set only when a page of newer reports exists — see `pagination.ts`. */
  newerHref: string | null;
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

/** The keyset-pagination boundary: strictly newer or older than the cursor report, compared
 * against the outer query's own `reportCreatedAt`/`reportId` columns.
 *
 * The scalar subquery goes straight to `report`, not through the outer query, so it still
 * resolves for a soft-deleted cursor report — `REQUIREMENTS.md` § Data deletion keeps the row,
 * and a stale bookmark should still page correctly. `(created_at, id)` — not `created_at` alone —
 * is a total order: two reports can share a timestamp, and an order that isn't total lets paging
 * repeat or skip a row.
 */
function cursorCondition(direction: 'older' | 'newer', cursor: ReportId) {
  const operator = direction === 'older' ? sql.raw('<') : sql.raw('>');
  // (created_at, id) < ((select created_at from report where id = :cursor), :cursor) — `>` for `newer`.
  return sql<boolean>`(${sql.ref('reportCreatedAt')}, ${sql.ref('reportId')}) ${operator} ((select created_at from report where id = ${cursor}), ${cursor})`;
}

/** A cursor naming a report that no longer exists at all (not merely soft-deleted) resolves to
 * `newest`, the same fallback `parseCursor` gives a malformed cursor — see its doc comment. Without
 * this, `cursorCondition`'s subquery returns NULL for such an id, which makes the row comparison
 * NULL for every row and silently empties the page instead of falling back.
 */
async function resolveCursor(db: DatabaseExecutor, cursor: ReportsCursor): Promise<ReportsCursor> {
  if (cursor.direction === 'newest') {
    return cursor;
  }
  const cursorReport = await db
    .selectFrom('report')
    .select('id')
    .where('id', '=', cursor.cursor)
    .executeTakeFirst();
  return cursorReport ? cursor : { direction: 'newest' };
}

/** One page of an organization's reports for the dashboard/list page, newest upload first
 * regardless of paging direction — see `ReportsCursor`.
 *
 * Filters on `organizationId` and `deleted_at is null`. `report_organization_id_created_at`
 * covers the ordering but not the deletion filter, so that's a heap recheck rather than
 * index-covered.
 */
export async function _loadReports(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; cursor: ReportsCursor },
): Promise<ReportsPageData> {
  const cursor = await resolveCursor(db, params.cursor);

  let query = db
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
          // response is one consistent snapshot.
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
    .selectAll();

  // `newer` walks the index ascending and gets reversed below, so its page comes out newest
  // first like every other direction — the caller never sees the ascending order.
  if (cursor.direction === 'newer') {
    query = query
      .where(cursorCondition('newer', cursor.cursor))
      .orderBy('reportCreatedAt', 'asc')
      .orderBy('reportId', 'asc');
  } else {
    if (cursor.direction === 'older') {
      query = query.where(cursorCondition('older', cursor.cursor));
    }
    query = query.orderBy('reportCreatedAt', 'desc').orderBy('reportId', 'desc');
  }

  // One extra row, discarded below, only to learn whether a further page exists in this
  // direction — the opposite direction follows from the request itself (see `ReportsCursor`).
  let rows: ReportListRowQuery[] = await query.limit(_REPORTS_PAGE_SIZE + 1).execute();
  const hasMoreInDirection = rows.length > _REPORTS_PAGE_SIZE;
  rows = rows.slice(0, _REPORTS_PAGE_SIZE);
  if (cursor.direction === 'newer') {
    rows.reverse();
  }

  // The opposite direction from the one requested exists by construction: paging `older` means a
  // newer page — the one just left — is there, and vice versa. Only the requested direction's
  // extra row settles whether *it* has a further page.
  let hasOlder: boolean;
  let hasNewer: boolean;
  switch (cursor.direction) {
    case 'newest':
      hasOlder = hasMoreInDirection;
      hasNewer = false;
      break;
    case 'older':
      hasOlder = hasMoreInDirection;
      hasNewer = true;
      break;
    case 'newer':
      hasOlder = true;
      hasNewer = hasMoreInDirection;
      break;
  }

  // The row to cursor from is normally an end of this page. A page can come back empty despite a
  // further page existing by construction — an `older`/`newer` link landing exactly on the last
  // row of the organization's history — so fall back to the cursor that got us here, which is
  // exactly as valid a boundary for the opposite direction.
  const newerCursorId =
    rows[0]?.reportId ?? (cursor.direction === 'older' ? cursor.cursor : undefined);
  const olderCursorId =
    rows[rows.length - 1]?.reportId ?? (cursor.direction === 'newer' ? cursor.cursor : undefined);

  return {
    newReportHref: newReportHref(params.organizationId),
    reports: rows.map((row) => toReportListRow(params.organizationId, row)),
    olderHref:
      hasOlder && olderCursorId ? olderReportsHref(params.organizationId, olderCursorId) : null,
    newerHref:
      hasNewer && newerCursorId ? newerReportsHref(params.organizationId, newerCursorId) : null,
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
