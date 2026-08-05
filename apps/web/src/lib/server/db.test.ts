/** These tests are only placeholders to prove the database wiring works.
 * Delete it once we have real tests that exercise the database.
 */

import { insertReport, withRollback } from '@gbd/db/testing';
import { afterAll, expect, test } from 'vitest';
import { closeDatabase, database } from './db.ts';

afterAll(async () => {
  await closeDatabase();
});

test('queries the database through the app handle, rolling back after', async () => {
  const id = await withRollback(database(), async (transaction) => {
    // Through the shared fixtures, which create the organization a report needs — and which are
    // exported from `@gbd/db/testing` precisely so the app's tests can reach them.
    const report = await insertReport(transaction, { name: 'From the web app' });

    expect(report).toMatchObject({ name: 'From the web app', countsBasis: 'people' });
    return report.id;
  });

  const afterRollback = await database()
    .selectFrom('report')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  expect(afterRollback).toBeUndefined();
});
