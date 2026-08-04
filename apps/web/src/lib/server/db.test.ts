/** These tests are only placeholders to prove the database wiring works.
 * Delete it once we have real tests that exercise the database.
 */

import { withRollback } from '@gbd/db/testing';
import { afterAll, expect, test } from 'vitest';
import { closeDatabase, database } from './db.ts';

afterAll(async () => {
  await closeDatabase();
});

test('queries the database through the app handle, rolling back after', async () => {
  const id = await withRollback(database(), async (transaction) => {
    const report = await transaction
      .insertInto('report')
      .values({
        name: 'From the web app',
        countsBasis: 'meals',
        monthlyCounts: { '2026-01': 40 },
        unitSystem: 'kg',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(report).toMatchObject({ name: 'From the web app', countsBasis: 'meals' });
    return report.id;
  });

  const afterRollback = await database()
    .selectFrom('report')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  expect(afterRollback).toBeUndefined();
});
