/** Proves the database toolchain end to end, against a real Postgres.
 *
 * Not really about `report` — that table is placeholder boilerplate. These tests exist to
 * catch the toolchain breaking: that migrations applied, that Kanel's generated types agree
 * with `CamelCasePlugin`, that enums and jsonb round-trip, and that `withRollback` leaves
 * nothing behind. The follow-up PR implementing `SCHEMA.md` adds the real invariant tests
 * alongside these, per `SCHEMA.md` § Conventions.
 */

import { POSTGRES_CODE_CHECK_VIOLATION } from '@gbd/db';
import { DATABASE } from '@gbd/db/env';
import { withRollback } from '@gbd/db/testing';
import { afterAll, describe, expect, test } from 'vitest';
import type { NewReport } from '../src/generated/public/Report.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

function aReport(overrides: Partial<NewReport> = {}): NewReport {
  return {
    countsBasis: 'people',
    monthlyCounts: { '2026-01': 120, '2026-02': 135 },
    unitSystem: 'lb',
    ...overrides,
  };
}

describe('report', () => {
  test('round-trips camelCase properties, enums, and jsonb', async () => {
    const inserted = await withRollback(DATABASE, async (transaction) => {
      // Every property here is camelCase while every column is snake_case. This only
      // compiles and only runs because Kanel's camelCase hook and Kysely's CamelCasePlugin
      // agree, which is the pairing most likely to silently drift.
      return await transaction
        .insertInto('report')
        .values(aReport({ name: 'Q1 procurement', siteName: 'Main dining hall' }))
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    expect(inserted).toMatchObject({
      name: 'Q1 procurement',
      siteName: 'Main dining hall',
      countsBasis: 'people',
      unitSystem: 'lb',
      monthlyCounts: { '2026-01': 120, '2026-02': 135 },
    });
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.deletedAt).toBeNull();
  });

  test('rejects a soft delete that predates creation', async () => {
    const createdAt = new Date('2026-03-01T00:00:00Z');
    const deletedAt = new Date('2026-02-01T00:00:00Z');

    const insert = withRollback(DATABASE, async (transaction) => {
      await transaction.insertInto('report').values(aReport({ createdAt, deletedAt })).execute();
    });

    // Naming the constraint proves *this* check fired, not some other failure.
    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'report_deleted_at_after_created_at',
    });
  });

  test('withRollback commits nothing', async () => {
    const id = await withRollback(DATABASE, async (transaction) => {
      const { id } = await transaction
        .insertInto('report')
        .values(aReport())
        .returning('id')
        .executeTakeFirstOrThrow();

      // Visible inside the transaction...
      await expect(
        transaction.selectFrom('report').select('id').where('id', '=', id).executeTakeFirst(),
      ).resolves.toMatchObject({ id });

      return id;
    });

    // ...and gone once it rolls back.
    const afterRollback = await DATABASE.selectFrom('report')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(afterRollback).toBeUndefined();
  });
});
