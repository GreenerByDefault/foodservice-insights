import {
  type DatabaseExecutor,
  MAX_ANALYSIS_ATTEMPTS,
  type OrganizationId,
  type ReportId,
  requireConstraint,
  type UserId,
} from '@gbd/db';
import {
  insertAnalysisAttempt,
  insertAppUser,
  insertInputFile,
  insertOrganization,
  insertReport,
  insertResultFile,
  NOW,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { statusOf } from '$lib/server/tests/http-error';
import { _loadReport } from './+page.server.ts';

const SUPPORT_EMAIL = 'support@foodservice-insights.test';

async function aReportWithInputFile(
  transaction: DatabaseExecutor,
  organizationId: OrganizationId,
  overrides: { siteName?: string; createdByUserId?: UserId | null } = {},
) {
  const report = await insertReport(transaction, { organizationId, ...overrides });
  await insertInputFile(transaction, { reportId: report.id });
  return report;
}

describe('a report the caller may see', () => {
  test('the latest attempt wins when there are several', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // A new attempt is only ever created after the previous one failed — see
      // analysis_attempt_new_attempt_only_after_failure — so this is the only shape a
      // multi-attempt report can be in.
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

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt.status).toBe('pending');
    });
  });

  test('a report in another organization is a 404, not a leak', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: owner } = await insertOrganization(transaction);
      const { organization: outsider } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, owner.id);
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      await expect(
        statusOf(() =>
          _loadReport(transaction, {
            organizationId: outsider.id,
            reportId: report.id,
            supportEmail: SUPPORT_EMAIL,
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('a report that does not exist is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);

      await expect(
        statusOf(() =>
          _loadReport(transaction, {
            organizationId: organization.id,
            reportId: crypto.randomUUID() as ReportId,
            supportEmail: SUPPORT_EMAIL,
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('a soft-deleted report is a 404, cancel request and all', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // Deleting a running report writes `cancel_requested_at` in the same transaction as
      // `deleted_at` (REQUIREMENTS.md § Data deletion), so this is the shape a deleted report
      // usually arrives in — and it must be a 404, not the stopped screen.
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        cancelRequestedAt: NOW,
      });
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date() })
        .where('id', '=', report.id)
        .execute();

      await expect(
        statusOf(() =>
          _loadReport(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            supportEmail: SUPPORT_EMAIL,
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('a report with no attempt is our bug, not a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      // One transaction always creates report, input_file and the first attempt together — this
      // fixture builds the state that transaction guarantees never exists.
      const report = await aReportWithInputFile(transaction, organization.id);

      await expect(
        statusOf(() =>
          _loadReport(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            supportEmail: SUPPORT_EMAIL,
          }),
        ),
      ).resolves.toEqual({ status: 500 });
    });
  });
});

describe('report.siteName', () => {
  test('is passed through when set', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id, {
        siteName: 'Riverside Diner',
      });
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.report.siteName).toBe('Riverside Diner');
    });
  });
});

describe('report.creator', () => {
  test('carries the display name of a named creator', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUser(transaction, { displayName: 'Dana Cook' });
      const report = await aReportWithInputFile(transaction, organization.id, {
        createdByUserId: user.id,
      });
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.report.creator).toEqual({ displayName: 'Dana Cook', email: expect.any(String) });
    });
  });

  test('falls back to email when the creator has no display name', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUser(transaction);
      const report = await aReportWithInputFile(transaction, organization.id, {
        createdByUserId: user.id,
      });
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.report.creator?.displayName).toBeNull();
      expect(data.report.creator?.email).toMatch(/@example\.test$/);
    });
  });

  test('is null when created_by_user_id is null (a deleted user)', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id, {
        createdByUserId: null,
      });
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.report.creator).toBeNull();
    });
  });
});

describe('each status narrows to the right variant', () => {
  test('pending', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const createdAt = new Date('2026-01-15T10:00:00Z');
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'pending',
        createdAt,
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({ status: 'pending', createdAt });
    });
  });

  test('processing', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const createdAt = new Date('2026-01-15T10:00:00Z');
      const claimedAt = new Date('2026-01-15T10:05:00Z');
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'processing',
        createdAt,
        claimedAt,
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({ status: 'processing', createdAt, claimedAt });
    });
  });

  test('failed', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const createdAt = new Date('2026-01-15T10:00:00Z');
      const finishedAt = new Date('2026-01-15T10:05:00Z');
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'failed',
        createdAt,
        finishedAt,
        failureReason: 'child_crashed',
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'failed',
        finishedAt,
        attemptNumber: 1,
        failure: {
          whatHappened: 'Something on our end interrupted the analysis before it could finish.',
          followUpText:
            'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
          canRetry: true,
          attemptsExhausted: false,
          contactMailto: `mailto:${SUPPORT_EMAIL}`,
        },
      });
    });
  });

  test('failed at the attempt cap: retry copy is suppressed even for a reason whose own follow-up is retry', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // Every earlier attempt must itself be `failed` — see
      // analysis_attempt_new_attempt_only_after_failure — so this is the only shape a
      // report at the cap can be in.
      for (let attemptNumber = 1; attemptNumber < MAX_ANALYSIS_ATTEMPTS; attemptNumber++) {
        await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          attemptNumber,
          status: 'failed',
        });
      }
      const lastAttempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        attemptNumber: MAX_ANALYSIS_ATTEMPTS,
        status: 'failed',
        // child_crashed's own follow-up is `retry` — the cap has to override it regardless of reason.
        failureReason: 'child_crashed',
      });
      // Read back rather than asserting a literal: every attempt here defaults to NOW (the
      // transaction's own now()), so this is whatever that resolved to.
      const finishedAt = requireConstraint(
        lastAttempt.finishedAt,
        'analysis_attempt_finished_at_iff_terminal',
      );

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'failed',
        finishedAt,
        attemptNumber: MAX_ANALYSIS_ATTEMPTS,
        failure: {
          whatHappened: 'Something on our end interrupted the analysis before it could finish.',
          followUpText: `You've used all ${MAX_ANALYSIS_ATTEMPTS} attempts for this report. Contact us and we can help figure out what to change.`,
          canRetry: false,
          attemptsExhausted: true,
          contactMailto: `mailto:${SUPPORT_EMAIL}`,
        },
      });
    });
  });

  test('succeeded', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const createdAt = new Date('2026-01-15T10:00:00Z');
      const claimedAt = new Date('2026-01-15T10:03:00Z');
      const finishedAt = new Date('2026-01-15T10:05:00Z');
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
        createdAt,
        claimedAt,
        finishedAt,
      });
      const pdf = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'pdf',
      });
      const xlsx = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'xlsx',
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'succeeded',
        createdAt,
        claimedAt,
        finishedAt,
        files: {
          pdf: { href: `/file/result/${pdf.id}` },
          xlsx: { href: `/file/result/${xlsx.id}` },
        },
      });
    });
  });

  test('canceled', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const createdAt = new Date('2026-01-15T10:00:00Z');
      const stoppedAt = new Date('2026-01-15T10:05:00Z');
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'canceled',
        createdAt,
        cancelRequestedAt: stoppedAt,
        // Intentionally different value than stoppedAt.
        finishedAt: new Date('2026-01-15T11:00:00Z'),
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({ status: 'canceled', stoppedAt });
    });
  });
});

/** The load's one real rule: a terminal status outranks a cancel request, and a request on a
 * non-terminal row is already the stopped screen even though no worker has converged it. Which
 * non-terminal statuses take that branch is `screenStatus`'s call, covered exhaustively in
 * `attempt-status.test.ts`; this only has to show `_loadReport` wires its verdict into
 * `stoppedAt` correctly for one of them.
 */
describe('a cancel request', () => {
  test('gives the stopped screen on a pending row, timed from the request', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'pending',
        cancelRequestedAt: NOW,
      });
      const stoppedAt = requireConstraint(
        attempt.cancelRequestedAt,
        'analysis_attempt_canceled_requires_request',
      );

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({ status: 'canceled', stoppedAt });
    });
  });

  test('loses to a succeeded row', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // The child finished inside the window before the parent's next lease renewal could kill it,
      // so the verdict stands and carries the request forever — see `markIfStillOwned`.
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
        cancelRequestedAt: NOW,
      });
      const pdf = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'pdf',
      });
      const xlsx = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'xlsx',
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'succeeded',
        createdAt: expect.any(Date),
        claimedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        files: {
          pdf: { href: `/file/result/${pdf.id}` },
          xlsx: { href: `/file/result/${xlsx.id}` },
        },
      });
    });
  });

  test('loses to a failed row, which keeps its retry copy', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'failed',
        cancelRequestedAt: NOW,
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt.status).toBe('failed');
    });
  });
});
