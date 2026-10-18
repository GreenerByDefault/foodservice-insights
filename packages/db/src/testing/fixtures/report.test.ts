import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import { checkDeferredConstraints, withRollback } from '../transactions.ts';
import { insertInputFile, insertReport } from './report.ts';

describe('insertReport', () => {
  test('commits as-is', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await insertReport(transaction);

      await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
    });
  });

  test('passes inputFile through to the input file it inserts', async () => {
    const storageKey = `org/test/${crypto.randomUUID()}.csv`;

    const storageKeys = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction, { inputFile: { storageKey } });
      return await transaction
        .selectFrom('inputFile')
        .select('storageKey')
        .where('reportId', '=', report.id)
        .execute();
    });

    expect(storageKeys).toEqual([{ storageKey }]);
  });
});

describe('insertInputFile', () => {
  test('commits as-is, without a second input file on the report it creates', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await insertInputFile(transaction);

      await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
    });
  });
});
