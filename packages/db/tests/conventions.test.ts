/** The schema-wide conventions from `README.md`, asserted against the whole catalog, plus the
 * toolchain-level guarantees every other test in this package depends on.
 */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import { insertOrganization, insertReport } from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

describe('conventions', () => {
  test('every table has a primary key', async () => {
    const { rows } = await withRollback(DATABASE, async (transaction) => {
      return await sql<{ name: string }>`
        SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT LIKE 'kysely\\_%'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p'
          )
      `.execute(transaction);
    });

    expect(rows.map((row) => row.name)).toEqual([]);
  });

  test('every foreign key has an index that can serve it', async () => {
    // Without one, deleting a referenced row sequentially scans the referencing table. A partial
    // index does not count: cleanup has to reach every row, not the ones matching a predicate.
    const { rows } = await withRollback(DATABASE, async (transaction) => {
      return await sql<{ name: string }>`
        SELECT c.conrelid::regclass::text || '.' || c.conname AS name
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND i.indpred IS NULL
              AND (i.indkey::smallint[])[0:array_length(c.conkey, 1) - 1] = c.conkey
          )
      `.execute(transaction);
    });

    expect(rows.map((row) => row.name)).toEqual([]);
  });

  test('every updated_at column has a trigger that maintains it', async () => {
    const { rows } = await withRollback(DATABASE, async (transaction) => {
      return await sql<{ name: string }>`
        SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
            JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = c.oid AND p.proname = 'set_updated_at' AND NOT t.tgisinternal
          )
      `.execute(transaction);
    });

    expect(rows.map((row) => row.name)).toEqual([]);
  });

  test('set_updated_at bumps the column on update', async () => {
    // `now()` is the transaction's start time, so a bump is only observable against a row that
    // was inserted claiming an older one. Exercised through `organization`, one of several
    // tables the trigger above proves are wired to this same function.
    const updatedAt = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction
        .updateTable('organization')
        .set({ updatedAt: new Date('2020-01-01T00:00:00Z') })
        .where('id', '=', organization.id)
        .execute();

      const updated = await transaction
        .updateTable('organization')
        .set({ name: `Renamed ${crypto.randomUUID()}` })
        .where('id', '=', organization.id)
        .returning('updatedAt')
        .executeTakeFirstOrThrow();
      return updated.updatedAt;
    });

    expect(updatedAt.getFullYear()).toBeGreaterThan(2020);
  });
});

describe('withRollback', () => {
  test('commits nothing', async () => {
    const id = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertReport(transaction);

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

describe('camelCase, enums, and jsonb', () => {
  test('round-trip through Kanel and CamelCasePlugin', async () => {
    const inserted = await withRollback(DATABASE, async (transaction) => {
      return await insertReport(transaction, {
        name: 'Q1 procurement',
        siteName: 'Main dining hall',
      });
    });

    expect(inserted).toMatchObject({
      name: 'Q1 procurement',
      siteName: 'Main dining hall',
      countsBasis: 'people',
      unitSystem: 'lb',
      monthlyCounts: { '2026-01': 120, '2026-02': 135 },
    });
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.deletedAt).toBeNull();
  });
});

describe('uuidv7', () => {
  test('produces version 7 ids carrying the current time', async () => {
    // Postgres 17 has no `uuidv7()` and its `uuid_extract_timestamp` handles only version 1, so
    // the timestamp is decoded here from the first 48 bits, which is where v7 puts it.
    const row = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ version: number; skewMs: string }>`
        WITH generated AS (SELECT uuidv7() AS id)
        SELECT
          uuid_extract_version(id) AS version,
          abs(
            ('x' || substr(replace(id::text, '-', ''), 1, 12))::bit(48)::bigint
            - (extract(epoch FROM clock_timestamp()) * 1000)::bigint
          ) AS "skewMs"
        FROM generated
      `.execute(transaction);
      return rows[0];
    });

    expect(row?.version).toBe(7);
    expect(Number(row?.skewMs)).toBeLessThan(10_000);
  });

  test('is unique and time-ordered', async () => {
    const row = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ distinctCount: string; ordered: boolean }>`
        SELECT
          (SELECT count(DISTINCT uuidv7()) FROM generate_series(1, 1000)) AS "distinctCount",
          (SELECT earlier < later FROM (SELECT uuidv7() AS earlier, pg_sleep(0.01), uuidv7() AS later) t)
            AS ordered
      `.execute(transaction);
      return rows[0];
    });

    expect(Number(row?.distinctCount)).toBe(1000);
    expect(row?.ordered).toBe(true);
  });
});
