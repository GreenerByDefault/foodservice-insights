import { insertAnalysisAttempt, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '#lib/server/db.js';
import { cancelActiveAttempt } from './cancel';

describe('cancelActiveAttempt', () => {
  test.each(['pending', 'processing'] as const)(
    'sets cancelRequestedAt and returns true for a %s attempt',
    async (status) => {
      await withRollback(database(), async (transaction) => {
        const report = await insertReport(transaction);
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id, status });

        await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(true);

        const updated = await transaction
          .selectFrom('analysisAttempt')
          .select('cancelRequestedAt')
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        expect(updated.cancelRequestedAt).toBeInstanceOf(Date);
      });
    },
  );

  test.each(['succeeded', 'failed', 'canceled'] as const)(
    'leaves a %s attempt untouched and returns false',
    async (status) => {
      await withRollback(database(), async (transaction) => {
        const report = await insertReport(transaction);
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id, status });

        await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(false);

        const untouched = await transaction
          .selectFrom('analysisAttempt')
          .select('cancelRequestedAt')
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        expect(untouched.cancelRequestedAt).toEqual(attempt.cancelRequestedAt);
      });
    },
  );

  test('returns false for a report with no attempt at all', async () => {
    await withRollback(database(), async (transaction) => {
      const report = await insertReport(transaction);

      await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(false);
    });
  });

  test('only touches the given report — a pending attempt on another report is untouched', async () => {
    await withRollback(database(), async (transaction) => {
      const target = await insertReport(transaction);
      const other = await insertReport(transaction);
      const otherAttempt = await insertAnalysisAttempt(transaction, {
        reportId: other.id,
        status: 'pending',
      });

      await expect(cancelActiveAttempt(transaction, target.id)).resolves.toBe(false);

      const untouched = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', otherAttempt.id)
        .executeTakeFirstOrThrow();
      expect(untouched.cancelRequestedAt).toBeNull();
    });
  });
});
