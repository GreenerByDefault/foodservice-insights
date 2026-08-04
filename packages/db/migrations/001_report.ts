/** A deliberately partial `report`, enough to prove the database toolchain works.
 *
 * This is **not** the schema. `SCHEMA.md` is still the spec, and the follow-up PR that
 * implements it in full will extend this migration. Deferred here because they all depend on
 * tables that do not exist yet:
 *
 *   - `organization_id`, `created_by_user_id`, `deleted_by_user_id` — need `organization` and
 *     `app_user`, and `app_user` needs Supabase Auth's `auth.users`.
 *   - the `(organization_id, created_at DESC)` and `(created_by_user_id, created_at DESC)`
 *     indexes, and the `deleted_by_user_id IS NULL OR deleted_at IS NOT NULL` check — all of
 *     them reference those columns.
 *   - `input_file`, `analysis_attempt`, `result_file`, `rejected_upload`, and the whole auth
 *     side of the schema.
 *
 * Nothing is deployed yet, so that PR may edit this file in place rather than layering a
 * second migration on top. Once anything is deployed, migrations are forward-only — see
 * ARCHITECTURE.md § Hosting.
 *
 * Columns are snake_case, always: `CamelCasePlugin` translates identifiers on the query
 * side, so `site_name` here is what lets `siteName` work there.
 */

import { type Kysely, sql } from 'kysely';

// A migration runs against whatever shape the schema had at the time, so it must not be
// typed with the current generated types. This is what Kysely's own docs prescribe.
// biome-ignore lint/suspicious/noExplicitAny: see above
type MigrationDatabase = Kysely<any>;

export async function up(database: MigrationDatabase): Promise<void> {
  await database.schema.createType('counts_basis').asEnum(['people', 'meals']).execute();
  await database.schema.createType('unit_system').asEnum(['lb', 'kg']).execute();

  await database.schema
    .createTable('report')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text')
    .addColumn('site_name', 'text')
    .addColumn('counts_basis', sql`counts_basis`, (column) => column.notNull())
    .addColumn('monthly_counts', 'jsonb', (column) => column.notNull())
    .addColumn('unit_system', sql`unit_system`, (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint(
      'report_deleted_at_after_created_at',
      sql`deleted_at IS NULL OR deleted_at >= created_at`,
    )
    .execute();
}
