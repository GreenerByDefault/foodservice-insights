/** The schema-wide conventions from `README.md`, asserted against the catalog instead of
 * remembered.
 *
 * Also here: the invariants that no single transaction can violate, and so have nothing to
 * assert against except their own existence.
 */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
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

describe('invariants with no single-transaction counterexample', () => {
  // These three cannot be provoked from one transaction — the first because the insert trigger
  // already rejects every sequential path to it, the others because they are properties of a
  // definition rather than of a row. Asserting they exist is what stops a refactor removing them
  // silently.

  test('at most one active attempt per report is enforced by a partial unique index', async () => {
    const index = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'analysis_attempt_one_active_per_report'
      `.execute(transaction);
      return rows[0]?.indexdef;
    });

    expect(index).toMatch(/UNIQUE INDEX/);
    expect(index).toMatch(/\(report_id\)/);
    expect(index).toMatch(/WHERE .*'pending'.*'processing'/);
  });

  test('the admin constraint triggers are deferred to commit', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const result = await sql<{ name: string; deferrable: boolean; deferred: boolean }>`
        SELECT tgname AS name, tgdeferrable AS deferrable, tginitdeferred AS deferred
        FROM pg_trigger
        WHERE tgname IN ('organization_member_at_least_one_admin', 'organization_has_a_member')
        ORDER BY tgname
      `.execute(transaction);
      return result.rows;
    });

    expect(rows).toEqual([
      { name: 'organization_has_a_member', deferrable: true, deferred: true },
      { name: 'organization_member_at_least_one_admin', deferrable: true, deferred: true },
    ]);
  });

  test('the auth.users trigger function is SECURITY DEFINER with a pinned search_path', async () => {
    // Supabase Auth connects as a role with no rights on `app_user`, so without SECURITY DEFINER
    // every signup fails — and with it, a mutable search_path is an escalation path. Neither is
    // observable from a test connecting as the owner, so assert the definition instead.
    const row = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ securityDefiner: boolean; config: string[] | null }>`
        SELECT prosecdef AS "securityDefiner", proconfig AS config
        FROM pg_proc WHERE proname = 'handle_new_auth_user'
      `.execute(transaction);
      return rows[0];
    });

    expect(row?.securityDefiner).toBe(true);
    expect(row?.config).toEqual(['search_path=""']);
  });
});
