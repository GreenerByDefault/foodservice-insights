/** A deliberately partial `report`, enough to prove the database toolchain works.
 *
 * This is **not** the schema — `SCHEMA.md` is still the spec, and the follow-up PR that
 * implements it in full may edit this file in place rather than layer a migration on top,
 * since nothing is deployed yet. Once anything is deployed, migrations are forward-only —
 * see ARCHITECTURE.md § Hosting.
 */

import { type Kysely, sql } from 'kysely';

export async function up(database: Kysely<any>): Promise<void> {
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
