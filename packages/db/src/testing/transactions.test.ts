import { describe, expect, test } from 'vitest';
import { DATABASE } from '../env.ts';
import type { ReportId } from '../generated/public/Report.ts';
import { insertReport } from './fixtures/index.ts';
import { withRollback } from './transactions.ts';

async function findReport(id: ReportId) {
  return await DATABASE.selectFrom('report').select('id').where('id', '=', id).executeTakeFirst();
}

describe('withRollback', () => {
  test('commits nothing', async () => {
    const id = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertReport(transaction);

      // Visible inside the transaction...
      await expect(
        transaction.selectFrom('report').select('id').where('id', '=', id).executeTakeFirst(),
      ).resolves.toEqual({ id });

      return id;
    });

    // ...and gone once it rolls back.
    await expect(findReport(id)).resolves.toBeUndefined();
  });

  test('rethrows a failure from the body, still rolled back', async () => {
    let id: ReportId | undefined;
    const failure = new Error('the body failed');

    await expect(
      withRollback(DATABASE, async (transaction) => {
        ({ id } = await insertReport(transaction));
        throw failure;
      }),
    ).rejects.toBe(failure);

    if (!id) throw new Error('the body never inserted a report');
    await expect(findReport(id)).resolves.toBeUndefined();
  });
});
