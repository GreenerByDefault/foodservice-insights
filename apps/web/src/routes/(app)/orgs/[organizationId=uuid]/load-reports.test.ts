import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import {
  insertAnalysisAttempt,
  insertAppUser,
  insertOrganization,
  insertReport,
  NOW,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { newReportHref, reportHref } from '$lib/reports/hrefs';
import { database } from '$lib/server/db';
import { _loadReports } from './+page.server.ts';

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

describe('_loadReports', () => {
  test('an organization with no reports returns an empty list', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);

      const data = await _loadReports(transaction, { organizationId: organization.id });

      expect(data).toEqual({
        newReportHref: newReportHref(organization.id),
        reports: [],
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

      const data = await _loadReports(transaction, { organizationId: organization.id });

      expect(data.reports.map((row) => row.id)).toEqual([newer.id, older.id]);
    });
  });

  test("another org's reports are absent", async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: owner } = await insertOrganization(transaction);
      const { organization: outsider } = await insertOrganization(transaction);
      await aReportWithAttempt(transaction, owner.id);

      const data = await _loadReports(transaction, { organizationId: outsider.id });

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

      const data = await _loadReports(transaction, { organizationId: organization.id });

      expect(data.reports).toEqual([]);
    });
  });

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

      const data = await _loadReports(transaction, { organizationId: organization.id });

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
        { status: 'pending', cancelRequestedAt: NOW },
      );

      const data = await _loadReports(transaction, { organizationId: organization.id });
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

      const data = await _loadReports(transaction, { organizationId: organization.id });

      expect(data.reports[0]?.creator).toBeNull();
    });
  });

  test('a report with a named creator', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUser(transaction, { displayName: 'Dana Cook' });
      await aReportWithAttempt(transaction, organization.id, { createdByUserId: user.id });

      const data = await _loadReports(transaction, { organizationId: organization.id });

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

      const data = await _loadReports(transaction, { organizationId: organization.id });

      expect(data.newReportHref).toBe(newReportHref(organization.id));
      expect(data.reports[0]?.href).toBe(reportHref(organization.id, report.id));
    });
  });
});
