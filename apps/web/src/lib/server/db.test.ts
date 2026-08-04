/** The web app can reach the database, and its tests roll back.
 *
 * `packages/db` covers the toolchain itself. This covers the seam that package cannot: that
 * `$env/dynamic/private` actually resolves here, and that the rollback harness works against
 * the handle the app builds for itself.
 */

import { withRollback } from '@gbd/db/testing';
import { afterAll, expect, test } from 'vitest';
import { DATABASE } from './db.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

test('queries the database through the app handle, rolling back after', async () => {
  const id = await withRollback(DATABASE, async (transaction) => {
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

  const afterRollback = await DATABASE.selectFrom('report')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  expect(afterRollback).toBeUndefined();
});
