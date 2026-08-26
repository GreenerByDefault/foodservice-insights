import type { DatabaseExecutor, OrganizationId, ReportId } from '@gbd/db';
import {
  insertAnalysisAttempt,
  insertInputFile,
  insertOrganization,
  insertReport,
  insertResultFile,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { statusOf } from '$lib/server/tests/http-error';
import { _loadReport } from './+page.server.ts';

// `_loadReport` takes this as a plain parameter rather than reading `$env/dynamic/private`
// itself, so tests never need a SvelteKit env context.
const SUPPORT_EMAIL = 'support@foodservice-insights.test';

/** A report with the input file it always has — one transaction writes both, so every fixture
 * below needs both to look like a real report rather than the one this file's own "no attempt"
 * test deliberately leaves incomplete.
 */
async function aReportWithInputFile(transaction: DatabaseExecutor, organizationId: OrganizationId) {
  const report = await insertReport(transaction, { organizationId });
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
        cancelRequestedAt: new Date(),
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

describe('each status narrows to the right variant', () => {
  test('pending', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'pending' });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'pending',
        createdAt: expect.any(Date),
      });
    });
  });

  test('processing', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'processing' });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'processing',
        createdAt: expect.any(Date),
        claimedAt: expect.any(Date),
      });
    });
  });

  test('failed', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // insertAnalysisAttempt defaults a failed attempt's failure_reason to 'child_crashed'.
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt).toEqual({
        status: 'failed',
        finishedAt: expect.any(Date),
        attemptNumber: 1,
        failure: {
          whatHappened: 'Something on our end interrupted the analysis before it could finish.',
          followUpText:
            'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
          canRetry: true,
          contactMailto: `mailto:${SUPPORT_EMAIL}`,
        },
      });
    });
  });

  test('canceled', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const stoppedAt = new Date();
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'canceled',
        cancelRequestedAt: stoppedAt,
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      // `stoppedAt` is the request, not `finished_at`, which the fixture sets to a later `now()`.
      expect(data.attempt).toEqual({ status: 'canceled', stoppedAt });
    });
  });
});

/** The load's one real rule: a terminal status outranks a cancel request, and a request on a
 * non-terminal row is already the stopped screen even though no worker has converged it.
 */
describe('a cancel request', () => {
  test.for(['pending', 'processing'] as const)(
    'gives the stopped screen on a %s row, timed from the request',
    async (status) => {
      await withRollback(database(), async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const report = await aReportWithInputFile(transaction, organization.id);
        const stoppedAt = new Date();
        await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          status,
          cancelRequestedAt: stoppedAt,
        });

        const data = await _loadReport(transaction, {
          organizationId: organization.id,
          reportId: report.id,
          supportEmail: SUPPORT_EMAIL,
        });

        expect(data.attempt).toEqual({ status: 'canceled', stoppedAt });
      });
    },
  );

  test('loses to a succeeded row, whose files are intact', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      // The child finished inside the window before the parent's next lease renewal could kill it,
      // so the verdict stands and carries the request forever — see `markIfStillOwned`.
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
        cancelRequestedAt: new Date(),
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
          charts: [],
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
        cancelRequestedAt: new Date(),
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

describe('succeeded', () => {
  // A succeeded attempt is guaranteed a pdf and an xlsx result file —
  // `analysis_attempt_succeeded_has_result_files` — so this is the only shape this fixture needs
  // to cover; the `requireConstraint` calls in `loadResultFiles` are what would fail loudly if
  // that guarantee were ever dropped.
  test('the pdf and xlsx the database guarantees both come back', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
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

      expect(data.attempt.status).toBe('succeeded');
      if (data.attempt.status !== 'succeeded') throw new Error('unreachable');
      expect(data.attempt.files.pdf).toEqual({ href: `/file/result/${pdf.id}` });
      expect(data.attempt.files.xlsx).toEqual({ href: `/file/result/${xlsx.id}` });
    });
  });

  test('charts come back ordered by chart_key, not insertion order', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await aReportWithInputFile(transaction, organization.id);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
      });
      await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
      await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
      // Inserted out of alphabetical order on purpose — `result_file.id` and `created_at` cannot
      // be trusted to order these (see the trap this load's comment names), so only an explicit
      // `ORDER BY chart_key` can make this test fail if that ordering is ever dropped.
      const totalSpend = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'chart',
        chartKey: 'total_spend',
      });
      const avgOrder = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'chart',
        chartKey: 'avg_order',
      });
      const topProducts = await insertResultFile(transaction, {
        analysisAttemptId: attempt.id,
        kind: 'chart',
        chartKey: 'top_products',
      });

      const data = await _loadReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        supportEmail: SUPPORT_EMAIL,
      });

      expect(data.attempt.status).toBe('succeeded');
      if (data.attempt.status !== 'succeeded') throw new Error('unreachable');
      expect(data.attempt.files.charts).toEqual([
        { href: `/file/result/${avgOrder.id}`, chartKey: 'avg_order' },
        { href: `/file/result/${topProducts.id}`, chartKey: 'top_products' },
        { href: `/file/result/${totalSpend.id}`, chartKey: 'total_spend' },
      ]);
    });
  });
});
