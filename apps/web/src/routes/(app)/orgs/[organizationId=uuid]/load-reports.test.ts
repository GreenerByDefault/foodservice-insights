import type { DatabaseExecutor, OrganizationId, ReportId } from '@gbd/db';
import {
  DB_NOW,
  insertAnalysisAttempt,
  insertAppUser,
  insertOrganization,
  insertReport,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import {
  newerReportsHref,
  newReportHref,
  olderReportsHref,
  reportHref,
  reportsPollHref,
} from '$lib/reports/hrefs';
import { database } from '$lib/server/db';
import { _loadReports, _loadReportsByIds, _REPORTS_PAGE_SIZE } from './+page.server.ts';
import type { ReportsCursor } from './pagination.ts';

const POLL_INTERVAL_MS = 1_000;

/** Every test loads with the same poll interval — only the org/cursor vary. */
function loadReports(
  transaction: DatabaseExecutor,
  args: { organizationId: OrganizationId; cursor: ReportsCursor },
) {
  return _loadReports(transaction, { ...args, pollIntervalMs: POLL_INTERVAL_MS });
}

async function aReportWithAttempt(
  transaction: DatabaseExecutor,
  organizationId: OrganizationId,
  overrides: Parameters<typeof insertReport>[1] = {},
  attemptOverrides: Omit<Parameters<typeof insertAnalysisAttempt>[1], 'reportId'> = {},
) {
  const report = await insertReport(transaction, { organizationId, ...overrides });
  await insertAnalysisAttempt(transaction, { reportId: report.id, ...attemptOverrides });
  return report;
}

/** `count` reports one minute apart, oldest first — so the caller gets a stable, distinct
 * `createdAt` per row without a tiebreak between them mattering. */
async function insertReports(
  transaction: DatabaseExecutor,
  organizationId: OrganizationId,
  count: number,
): Promise<ReportId[]> {
  const ids: ReportId[] = [];
  for (let i = 0; i < count; i++) {
    const report = await aReportWithAttempt(transaction, organizationId, {
      createdAt: new Date(2026, 0, 1, 0, i),
    });
    ids.push(report.id);
  }
  return ids;
}

describe('_loadReports', () => {
  describe('which reports are returned', () => {
    test('an organization with no reports returns an empty list', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data).toEqual({
          newReportHref: newReportHref(organization.id),
          reports: [],
          olderHref: null,
          newerHref: null,
          pollHref: reportsPollHref(organization.id),
          pollIntervalMs: POLL_INTERVAL_MS,
        });
      });
    });

    test('newest upload first', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const older = await insertReport(transaction, {
          organizationId: organization.id,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        });
        await insertAnalysisAttempt(transaction, { reportId: older.id });
        const newer = await insertReport(transaction, {
          organizationId: organization.id,
          createdAt: new Date('2026-01-15T00:00:00Z'),
        });
        await insertAnalysisAttempt(transaction, { reportId: newer.id });

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports.map((row) => row.id)).toEqual([newer.id, older.id]);
      });
    });

    test("another org's reports are absent", async () => {
      await withRollback(database(), async (transaction) => {
        const { organization: owner } = await insertOrganization(transaction);
        const { organization: outsider } = await insertOrganization(transaction);
        await aReportWithAttempt(transaction, owner.id);

        const data = await loadReports(transaction, {
          organizationId: outsider.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports).toEqual([]);
      });
    });

    test('a soft-deleted report is absent', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const report = await aReportWithAttempt(transaction, organization.id);
        await transaction
          .updateTable('report')
          .set({ deletedAt: new Date() })
          .where('id', '=', report.id)
          .execute();

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports).toEqual([]);
      });
    });
  });

  describe('row content', () => {
    test('the latest attempt decides a row status when a report has several', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        // A new attempt is only ever created after the previous one failed — see
        // analysis_attempt_new_attempt_only_after_failure — so this is the only shape a
        // multi-attempt report can be in.
        const report = await insertReport(transaction, { organizationId: organization.id });
        await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          attemptNumber: 1,
          status: 'failed',
        });
        await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          attemptNumber: 2,
          status: 'pending',
        });

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports).toHaveLength(1);
        expect(data.reports[0]?.status).toBe('pending');
      });
    });

    test('each of the five screen statuses', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const pending = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'pending' },
        );
        const processing = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'processing' },
        );
        const succeeded = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'succeeded' },
        );
        const failed = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'failed' },
        );
        const canceled = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'canceled' },
        );
        // A cancel request on a still-pending attempt reads as `canceled` before the worker
        // converges it — see `screenStatus`.
        const cancelRequested = await aReportWithAttempt(
          transaction,
          organization.id,
          {},
          { status: 'pending', cancelRequestedAt: DB_NOW },
        );

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });
        const statusOf = (id: string) => data.reports.find((row) => row.id === id)?.status;

        expect(statusOf(pending.id)).toBe('pending');
        expect(statusOf(processing.id)).toBe('processing');
        expect(statusOf(succeeded.id)).toBe('succeeded');
        expect(statusOf(failed.id)).toBe('failed');
        expect(statusOf(canceled.id)).toBe('canceled');
        expect(statusOf(cancelRequested.id)).toBe('canceled');
      });
    });

    test('a report whose creator was deleted', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        await aReportWithAttempt(transaction, organization.id, { createdByUserId: null });

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports[0]?.creator).toBeNull();
      });
    });

    test('a report with a named creator', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const user = await insertAppUser(transaction, { displayName: 'Dana Cook' });
        await aReportWithAttempt(transaction, organization.id, { createdByUserId: user.id });

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports[0]?.creator).toEqual({
          displayName: 'Dana Cook',
          email: expect.any(String),
        });
      });
    });

    test('mints hrefs server-side', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const report = await aReportWithAttempt(transaction, organization.id);

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.newReportHref).toBe(newReportHref(organization.id));
        expect(data.reports[0]?.href).toBe(reportHref(organization.id, report.id));
        expect(data.pollHref).toBe(reportsPollHref(organization.id));
      });
    });
  });
});

describe('_loadReports pagination', () => {
  describe('page boundaries', () => {
    test('a page of exactly _REPORTS_PAGE_SIZE reports has no Older or Newer link', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE);

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports).toHaveLength(_REPORTS_PAGE_SIZE);
        expect(data.olderHref).toBeNull();
        expect(data.newerHref).toBeNull();
      });
    });

    test('more than a page shows Older but not Newer on the newest page', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE + 1);
        const newestFirst = [...ids].reverse();

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });

        expect(data.reports.map((row) => row.id)).toEqual(newestFirst.slice(0, _REPORTS_PAGE_SIZE));
        expect(data.newerHref).toBeNull();
        expect(data.olderHref).toBe(
          olderReportsHref(organization.id, newestFirst[_REPORTS_PAGE_SIZE - 1] as ReportId),
        );
      });
    });

    test('a partial last page has no further Older link', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE + 5);
        const newestFirst = [...ids].reverse();
        const firstPageLast = newestFirst[_REPORTS_PAGE_SIZE - 1] as ReportId;

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: firstPageLast },
        });

        expect(data.reports.map((row) => row.id)).toEqual(newestFirst.slice(_REPORTS_PAGE_SIZE));
        expect(data.reports).toHaveLength(5);
        expect(data.olderHref).toBeNull();
        expect(data.newerHref).not.toBeNull();
      });
    });

    test('an older page with a further older page shows both links', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE * 2 + 1);
        const newestFirst = [...ids].reverse();
        const firstPageLast = newestFirst[_REPORTS_PAGE_SIZE - 1] as ReportId;

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: firstPageLast },
        });

        expect(data.reports.map((row) => row.id)).toEqual(
          newestFirst.slice(_REPORTS_PAGE_SIZE, _REPORTS_PAGE_SIZE * 2),
        );
        expect(data.newerHref).toBe(
          newerReportsHref(organization.id, data.reports[0]?.id as ReportId),
        );
        expect(data.olderHref).toBe(
          olderReportsHref(organization.id, data.reports[data.reports.length - 1]?.id as ReportId),
        );
      });
    });

    test('paging older then newer returns to the same rows', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE + 5);

        const firstPage = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newest' },
        });
        const lastOfFirstPage = firstPage.reports[firstPage.reports.length - 1]?.id as ReportId;

        const olderPage = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: lastOfFirstPage },
        });
        const firstOfOlderPage = olderPage.reports[0]?.id as ReportId;

        const newerPage = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newer', cursor: firstOfOlderPage },
        });

        expect(newerPage.reports.map((row) => row.id)).toEqual(
          firstPage.reports.map((row) => row.id),
        );
      });
    });
  });

  describe('paging past the ends of the list', () => {
    test('paging older past the last report gives an empty page with only a Newer link', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, 3);
        const oldest = ids[0] as ReportId;

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: oldest },
        });

        expect(data.reports).toEqual([]);
        expect(data.olderHref).toBeNull();
        expect(data.newerHref).toBe(newerReportsHref(organization.id, oldest));
      });
    });

    test('paging newer past the first report gives an empty page with only an Older link', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, 3);
        const newest = ids[ids.length - 1] as ReportId;

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newer', cursor: newest },
        });

        expect(data.reports).toEqual([]);
        expect(data.olderHref).toBe(olderReportsHref(organization.id, newest));
        expect(data.newerHref).toBeNull();
      });
    });
  });

  describe('cursor resolution', () => {
    test('a cursor naming a report that does not exist falls back to the newest page', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE + 1);
        const newestFirst = [...ids].reverse();
        const missingCursor = crypto.randomUUID() as ReportId;

        const olderPage = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: missingCursor },
        });
        const newerPage = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'newer', cursor: missingCursor },
        });

        expect(olderPage.reports.map((row) => row.id)).toEqual(
          newestFirst.slice(0, _REPORTS_PAGE_SIZE),
        );
        expect(newerPage.reports.map((row) => row.id)).toEqual(
          newestFirst.slice(0, _REPORTS_PAGE_SIZE),
        );
      });
    });

    test('a cursor whose report has been soft-deleted still pages', async () => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const ids = await insertReports(transaction, organization.id, _REPORTS_PAGE_SIZE + 5);
        const newestFirst = [...ids].reverse();
        const cursorId = newestFirst[_REPORTS_PAGE_SIZE - 1] as ReportId;
        await transaction
          .updateTable('report')
          .set({ deletedAt: new Date() })
          .where('id', '=', cursorId)
          .execute();

        const data = await loadReports(transaction, {
          organizationId: organization.id,
          cursor: { direction: 'older', cursor: cursorId },
        });

        expect(data.reports.map((row) => row.id)).toEqual(newestFirst.slice(_REPORTS_PAGE_SIZE));
      });
    });
  });
});

describe('_loadReportsByIds', () => {
  test('an empty id list returns an empty list without a query', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);

      const data = await _loadReportsByIds(transaction, {
        organizationId: organization.id,
        ids: [],
      });

      expect(data).toEqual({ reports: [] });
    });
  });

  test('returns only the given, still-visible ids, regardless of order requested', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const first = await aReportWithAttempt(transaction, organization.id);
      const second = await aReportWithAttempt(transaction, organization.id);
      const notRequested = await aReportWithAttempt(transaction, organization.id);

      const data = await _loadReportsByIds(transaction, {
        organizationId: organization.id,
        ids: [second.id, first.id],
      });

      expect(data.reports.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
      expect(data.reports.map((row) => row.id)).not.toContain(notRequested.id);
    });
  });

  test('a soft-deleted report is absent, even when its id is requested', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithAttempt(transaction, organization.id);
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date() })
        .where('id', '=', report.id)
        .execute();

      const data = await _loadReportsByIds(transaction, {
        organizationId: organization.id,
        ids: [report.id],
      });

      expect(data.reports).toEqual([]);
    });
  });

  test("another org's report is absent, even when its id is requested", async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: owner } = await insertOrganization(transaction);
      const { organization: outsider } = await insertOrganization(transaction);
      const report = await aReportWithAttempt(transaction, owner.id);

      const data = await _loadReportsByIds(transaction, {
        organizationId: outsider.id,
        ids: [report.id],
      });

      expect(data.reports).toEqual([]);
    });
  });

  test('the latest attempt decides a row status when a report has several', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        attemptNumber: 1,
        status: 'failed',
      });
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        attemptNumber: 2,
        status: 'pending',
      });

      const data = await _loadReportsByIds(transaction, {
        organizationId: organization.id,
        ids: [report.id],
      });

      expect(data.reports).toHaveLength(1);
      expect(data.reports[0]?.status).toBe('pending');
    });
  });
});
