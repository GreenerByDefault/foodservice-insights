/** Delete every row, keeping the schema. `TEST_DB=1` targets the test stack.
 *
 *   pnpm db:truncate
 *   TEST_DB=1 pnpm db:truncate
 *
 * Unit tests do not need this — they roll their transactions back. It is for e2e, which
 * commits, and for clearing out a dev database by hand.
 */

import { sql } from 'kysely';
import { DATABASE, shutdown } from '../src/env.ts';

/** Truncate every table in `public` except Kysely's own migration bookkeeping.
 *
 * Driven off `pg_tables` rather than a hardcoded list so it cannot drift from the schema.
 * One statement, so `CASCADE` doesn't have to fight foreign key ordering.
 */
async function truncateAll(): Promise<void> {
  const { rows } = await sql<{ tableName: string }>`
    SELECT tablename AS "tableName"
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')
  `.execute(DATABASE);

  if (rows.length === 0) {
    console.log('nothing to truncate');
    return;
  }

  const tables = rows.map(({ tableName }) => sql.table(tableName));
  await sql`TRUNCATE TABLE ${sql.join(tables)} CASCADE`.execute(DATABASE);
  console.log(`truncated ${rows.length} table(s)`);
}

try {
  await truncateAll();
} finally {
  await shutdown();
}
