/** Every connection this suite opens sends `gbd.writer`, so each test clears it for its own
 * transaction to act as an unmarked `postgres` session. */

import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import { POSTGRES_CODE_INSUFFICIENT_PRIVILEGE } from '../src/postgres-codes.ts';
import type { Database } from '../src/schema.ts';
import { withRollback } from '../src/testing/transactions.ts';

const CACHE_TABLES = [
  'public.entree_classification',
  'public.product_categorization',
  'public.unit_weight',
];

// `pg_trigger.tgtype` bits: BEFORE (2), INSERT (4), DELETE (8), UPDATE (16), TRUNCATE (32), and
// ROW (1) unset, so once per statement.
const EVERY_WRITE = 2 | 4 | 8 | 16 | 32;
const TRUNCATE_ONLY = 2 | 32;

async function unmark(transaction: Transaction<Database>): Promise<void> {
  await sql`SET LOCAL gbd.writer = ''`.execute(transaction);
}

function refusal(operation: string) {
  return {
    code: POSTGRES_CODE_INSUFFICIENT_PRIVILEGE,
    message: `${operation} refused: only the apps write to this database`,
    hint: 'See the runbook "Write to the database by hand". AI agents: stop and ask a human.',
  };
}

describe('forbid_unmarked_write', () => {
  test('guards every table, and only truncation of the cache tables', async () => {
    const { rows } = await withRollback(DATABASE, async (transaction) => {
      return await sql<{ table: string; type: number | null }>`
        SELECT n.nspname || '.' || c.relname AS "table", t.tgtype AS "type"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_trigger t ON t.tgrelid = c.oid
          AND t.tgname = 'forbid_unmarked_write'
          AND t.tgfoid = 'public.forbid_unmarked_write'::regproc
        WHERE c.relkind IN ('r', 'p')
          AND (n.nspname IN ('public', 'metrics') OR c.oid = 'auth.users'::regclass)
        ORDER BY 1
      `.execute(transaction);
    });

    expect(rows).toEqual(
      rows.map(({ table }) => ({
        table,
        type: CACHE_TABLES.includes(table) ? TRUNCATE_ONLY : EVERY_WRITE,
      })),
    );
    expect(rows.map(({ table }) => table)).toEqual(expect.arrayContaining(CACHE_TABLES));
  });

  describe('on a table carrying it', () => {
    // A table created inside the rolled-back transaction, so the TRUNCATE locks no table another
    // test is using.
    function withUnmarkedProbe<T>(fn: (transaction: Transaction<Database>) => Promise<T>) {
      return withRollback(DATABASE, async (transaction) => {
        await sql`CREATE TABLE write_guard_probe (id int)`.execute(transaction);
        await sql`
          CREATE TRIGGER forbid_unmarked_write
            BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON write_guard_probe
            FOR EACH STATEMENT EXECUTE FUNCTION forbid_unmarked_write()
        `.execute(transaction);
        await unmark(transaction);
        return await fn(transaction);
      });
    }

    test.each([
      ['INSERT', sql`INSERT INTO write_guard_probe VALUES (1)`],
      ['UPDATE', sql`UPDATE write_guard_probe SET id = 2`],
      ['DELETE', sql`DELETE FROM write_guard_probe`],
      ['TRUNCATE', sql`TRUNCATE write_guard_probe`],
    ])('refuses an unmarked %s', async (operation, statement) => {
      await expect(
        withUnmarkedProbe((transaction) => statement.execute(transaction)),
      ).rejects.toMatchObject(refusal(`${operation} on public.write_guard_probe`));
    });

    test('allows a write marked by hand for its transaction', async () => {
      const { rows } = await withUnmarkedProbe(async (transaction) => {
        await sql`SET LOCAL gbd.writer = 'manual:test'`.execute(transaction);
        return await sql`INSERT INTO write_guard_probe VALUES (1) RETURNING id`.execute(
          transaction,
        );
      });

      expect(rows).toEqual([{ id: 1 }]);
    });
  });
});

describe('forbid_unmarked_ddl', () => {
  test('refuses an unmarked schema change', async () => {
    const created = withRollback(DATABASE, async (transaction) => {
      await unmark(transaction);
      await sql`CREATE TABLE write_guard_probe ()`.execute(transaction);
    });

    await expect(created).rejects.toMatchObject(refusal('CREATE TABLE'));
  });
});
