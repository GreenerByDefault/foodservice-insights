import type { Database, ReportId } from '@gbd/db';
import { insertAnalysisAttempt, insertInputFile, insertReport } from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '$lib/server/db';
import type { Session } from '$lib/server/session';
import { withReportFixtures } from '$lib/server/tests/fixtures';
import { _loadReport } from './+page.server.ts';

afterAll(async () => {
  await closeDatabase();
});

/** A report belonging to `session`, with its input file. */
async function aReport(transaction: Transaction<Database>, session: Session) {
  const report = await insertReport(transaction, {
    organizationId: session.organization.id,
    createdByUserId: session.userId,
    name: 'Q1 procurement',
  });
  const inputFile = await insertInputFile(transaction, { reportId: report.id });
  return { report, inputFile };
}

describe('_loadReport', () => {
  test('returns the report with its input file', async () => {
    await withReportFixtures(async ({ transaction, session }) => {
      const { report, inputFile } = await aReport(transaction, session);

      expect(await _loadReport(transaction, session, report.id)).toMatchObject({
        id: report.id,
        name: 'Q1 procurement',
        countsBasis: 'people',
        unitSystem: 'lb',
        monthlyCounts: { '2026-01': 120, '2026-02': 135 },
        inputFile: { id: inputFile.id, originalFilename: inputFile.originalFilename },
        attempt: null,
      });
    });
  });

  test('never returns the storage key, so the only way to the file is /file/input/{id}', async () => {
    await withReportFixtures(async ({ transaction, session }) => {
      const { report } = await aReport(transaction, session);

      const view = await _loadReport(transaction, session, report.id);
      expect(JSON.stringify(view)).not.toContain('storageKey');
    });
  });

  test('returns the pending attempt a worker has not claimed yet', async () => {
    await withReportFixtures(async ({ transaction, session }) => {
      const { report } = await aReport(transaction, session);
      await insertAnalysisAttempt(transaction, { reportId: report.id });

      expect(await _loadReport(transaction, session, report.id)).toMatchObject({
        attempt: {
          attemptNumber: 1,
          status: 'pending',
          lockedAt: null,
          lastHeartbeatAt: null,
          finishedAt: null,
          failureReason: null,
        },
      });
    });
  });

  test('returns the latest attempt, not the first', async () => {
    await withReportFixtures(async ({ transaction, session }) => {
      const { report } = await aReport(transaction, session);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });
      await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        attemptNumber: 2,
        status: 'processing',
      });

      expect(await _loadReport(transaction, session, report.id)).toMatchObject({
        attempt: { attemptNumber: 2, status: 'processing' },
      });
    });
  });

  test('surfaces why the latest attempt failed', async () => {
    await withReportFixtures(async ({ transaction, session }) => {
      const { report } = await aReport(transaction, session);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });

      expect(await _loadReport(transaction, session, report.id)).toMatchObject({
        attempt: { status: 'failed', failureReason: 'child_crashed' },
      });
    });
  });

  describe('404s for', () => {
    test('a report that does not exist', async () => {
      await withReportFixtures(async ({ transaction, session }) => {
        const missing = crypto.randomUUID() as ReportId;

        await expect(_loadReport(transaction, session, missing)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a report belonging to another organization', async () => {
      await withReportFixtures(async ({ transaction, session }) => {
        // Someone else's report, created through the fixtures' own organization.
        const theirs = await insertReport(transaction);
        await insertInputFile(transaction, { reportId: theirs.id });

        await expect(_loadReport(transaction, session, theirs.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a soft-deleted report', async () => {
      await withReportFixtures(async ({ transaction, session }) => {
        const { report } = await aReport(transaction, session);
        await transaction
          .updateTable('report')
          .set({ deletedAt: new Date(), deletedByUserId: session.userId })
          .where('id', '=', report.id)
          .execute();

        await expect(_loadReport(transaction, session, report.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });
  });
});
