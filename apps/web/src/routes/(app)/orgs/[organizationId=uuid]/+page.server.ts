import type { AnalysisAttemptStatus, DatabaseExecutor, OrganizationId, ReportId } from '@gbd/db';
import { sql } from 'kysely';
import { env } from '$env/dynamic/private';
import {
  newerReportsHref,
  newReportHref,
  olderReportsHref,
  reportHref,
  reportsPollHref,
} from '$lib/hrefs';
import { pollIntervalMsForWorkerMode } from '$lib/polling/schedule';
import { screenStatus } from '$lib/reports/attempt-status';
import type { Creator } from '$lib/reports/subheading';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';
import { parseCursor, type ReportsCursor } from './pagination.ts';

export const load: PageServerLoad = async ({ params, url }) => {
  const organizationId = params.organizationId as OrganizationId;
  const cursor = parseCursor(url.searchParams);

  return await withDbErrorHandling(
    () =>
      _loadReports(database(), {
        organizationId,
        cursor,
        pollIntervalMs: pollIntervalMsForWorkerMode(env.WORKER_MODE),
      }),
    { action: "load an organization's reports", context: { organizationId } },
  );
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
  /** Where the poller sends the ids it wants refreshed — see `poll/+server.ts`. */
  pollHref: string;
  pollIntervalMs: number;
};

/** What a poll refreshes: latest field values for the given reports. */
export type ReportsPollData = {
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

// -----------------------------------------------------
// Cursor
// -----------------------------------------------------

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

// -----------------------------------------------------
// Query
// -----------------------------------------------------

/** Every live report in the organization, one row each, carrying its latest attempt — the shape
 * both list reads start from, so what a row shows can only change for both at once.
 *
 * DISTINCT ON keeps this a single query instead of the N+1 an `order by attempt_number desc limit
 * 1` per report would become at list scale; both forms hit
 * `analysis_attempt_report_id_attempt_number` on its leading column, and keeping the latest
 * attempt this way is safe because of the `(report_id, attempt_number)` unique constraint.
 * Postgres requires DISTINCT ON's expression to lead ORDER BY, which is why nothing here orders
 * by report — a caller that needs its own order wraps this in a subquery.
 */
function latestAttemptPerReport(db: DatabaseExecutor, organizationId: OrganizationId) {
  return (
    db
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
        // Selected alongside the row rather than as a separate query, so every row of one response
        // is one consistent snapshot.
        sql<Date>`now()`.as('now'),
      ])
      .where('report.organizationId', '=', organizationId)
      .where('report.deletedAt', 'is', null)
      .distinctOn('report.id')
      .orderBy('report.id')
      .orderBy('analysisAttempt.attemptNumber', 'desc')
  );
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
  params: { organizationId: OrganizationId; cursor: ReportsCursor; pollIntervalMs: number },
): Promise<ReportsPageData> {
  const cursor = await resolveCursor(db, params.cursor);

  // Wrapped in a subquery because DISTINCT ON dictates its own ORDER BY (see
  // `latestAttemptPerReport`), leaving the outer query free to order by report instead.
  let query = db
    .selectFrom(latestAttemptPerReport(db, params.organizationId).as('latest'))
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

  const { hasOlder, hasNewer } = paginationFlags(cursor.direction, hasMoreInDirection);
  const { olderCursorId, newerCursorId } = pagingCursorIds(rows, cursor);

  return {
    newReportHref: newReportHref(params.organizationId),
    reports: rows.map((row) => toReportListRow(params.organizationId, row)),
    olderHref:
      hasOlder && olderCursorId ? olderReportsHref(params.organizationId, olderCursorId) : null,
    newerHref:
      hasNewer && newerCursorId ? newerReportsHref(params.organizationId, newerCursorId) : null,
    pollHref: reportsPollHref(params.organizationId),
    pollIntervalMs: params.pollIntervalMs,
  };
}

/** Refreshes latest field values for exactly the given reports, for the list's poller.
 *
 * Deliberately not paginated: a poll only ever asks about reports already on the client's
 * screen, so there is no cursor, ordering, or Older/Newer recompute here — see `poll/+server.ts`.
 * That also means a poll can only shrink what's on screen, never grow it: it re-fetches exactly
 * the ids already there, so a new upload never appears until the next navigation. But an id for
 * a deleted report is silently absent from the result, and the caller removes it from the screen.
 */
export async function _loadReportsByIds(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; ids: ReportId[] },
): Promise<ReportsPollData> {
  if (params.ids.length === 0) {
    return { reports: [] };
  }

  const rows = await latestAttemptPerReport(db, params.organizationId)
    .where('report.id', 'in', params.ids)
    .execute();

  return { reports: rows.map((row) => toReportListRow(params.organizationId, row)) };
}

/** Whether the page should show an Older/Newer link, given the direction paged and whether the
 * query's extra row confirmed more exist in that direction.
 *
 * The opposite direction from the one requested exists by construction: paging `older` means a
 * newer page — the one just left — is there, and vice versa. Only the requested direction's extra
 * row settles whether *it* has a further page.
 */
function paginationFlags(
  direction: ReportsCursor['direction'],
  hasMoreInDirection: boolean,
): { hasOlder: boolean; hasNewer: boolean } {
  switch (direction) {
    case 'newest':
      return { hasOlder: hasMoreInDirection, hasNewer: false };
    case 'older':
      return { hasOlder: hasMoreInDirection, hasNewer: true };
    case 'newer':
      return { hasOlder: true, hasNewer: hasMoreInDirection };
  }
}

/** The report id each direction's link should cursor from.
 *
 * The row to cursor from is normally an end of this page. A page can come back empty despite a
 * further page existing by construction — an `older`/`newer` link landing exactly on the last row
 * of the organization's history — so fall back to the cursor that got us here, which is exactly as
 * valid a boundary for the opposite direction.
 */
function pagingCursorIds(
  rows: ReportListRowQuery[],
  cursor: ReportsCursor,
): { newerCursorId: ReportId | undefined; olderCursorId: ReportId | undefined } {
  return {
    newerCursorId: rows[0]?.reportId ?? (cursor.direction === 'older' ? cursor.cursor : undefined),
    olderCursorId:
      rows[rows.length - 1]?.reportId ?? (cursor.direction === 'newer' ? cursor.cursor : undefined),
  };
}

// -----------------------------------------------------
// Row mapping
// -----------------------------------------------------

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
