import type { Kysely } from 'kysely';

// GBD retired the weights cache: its answers never held up well enough to reuse, so the lab now
// asks the LLM for every unit. The table's triggers, grants and TRUNCATE write guard go with it.
// `set_verified_at` and `set_updated_at` stay, for the other cache tables.

export async function up(database: Kysely<any>): Promise<void> {
  await database.schema.dropTable('unit_weight').execute();
}
