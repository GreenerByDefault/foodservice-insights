import { type Kysely, sql } from 'kysely';

/**
 * Attach the `set_updated_at()` trigger (created in `001_initial_schema`) to a table's
 * `updated_at` column. Call this from any migration that adds a table with an updated_at column.
 */
export async function updatedAtTrigger(database: Kysely<any>, table: string): Promise<void> {
  await sql`
    CREATE TRIGGER ${sql.raw(`${table}_set_updated_at`)}
      BEFORE UPDATE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `.execute(database);
}

/**
 * Attach the `set_verified_at()` trigger (created in `002_caches`) to a table's `is_verified` and
 * `verified_at` columns. Call this from any migration that adds a reviewed cache table.
 */
export async function verifiedAtTrigger(database: Kysely<any>, table: string): Promise<void> {
  await sql`
    CREATE TRIGGER ${sql.raw(`${table}_set_verified_at`)}
      BEFORE INSERT OR UPDATE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION set_verified_at()
  `.execute(database);
}

/**
 * Attach the `forbid_unmarked_write()` guard (created in `012_write_guard`) to a table. Call this
 * from any migration that adds a table. Pass `'truncate'` for a table people edit by hand in the
 * Table Editor, such as a cache, so that only TRUNCATE is refused.
 */
export async function writeGuardTrigger(
  database: Kysely<any>,
  table: string,
  operations: 'all' | 'truncate' = 'all',
): Promise<void> {
  const events = operations === 'all' ? 'INSERT OR UPDATE OR DELETE OR TRUNCATE' : 'TRUNCATE';
  await sql`
    CREATE TRIGGER forbid_unmarked_write
      BEFORE ${sql.raw(events)} ON ${sql.table(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_unmarked_write()
  `.execute(database);
}
