import { describe, expect, test } from 'vitest';
import { DATABASE } from '../env.ts';
import { insertAnalysisAttempt } from './fixtures.ts';
import { withRollback } from './transactions.ts';

describe('insertAnalysisAttempt', () => {
  test.for(['succeeded', 'failed'] as const)(
    'claims a %s attempt, since only a claimed attempt can reach a terminal status',
    async (status) => {
      await withRollback(DATABASE, async (transaction) => {
        const attempt = await insertAnalysisAttempt(transaction, { status });

        expect(attempt.workerId).not.toBeNull();
        expect(attempt.claimedAt).not.toBeNull();
        expect(attempt.leaseRenewedAt).not.toBeNull();
      });
    },
  );

  test('leaves a canceled attempt unclaimed by default', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'canceled' });

      expect(attempt.workerId).toBeNull();
      expect(attempt.claimedAt).toBeNull();
    });
  });

  test.for(['succeeded', 'failed'] as const)(
    'backdates the claim to a backdated finishedAt on a %s attempt, so the lease is not renewed after it finished',
    async (status) => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const finishedAt = new Date('2024-01-01T00:05:00Z');

      await withRollback(DATABASE, async (transaction) => {
        const attempt = await insertAnalysisAttempt(transaction, { status, createdAt, finishedAt });

        expect(attempt.claimedAt).toEqual(finishedAt);
        expect(attempt.leaseRenewedAt).toEqual(finishedAt);
      });
    },
  );
});
