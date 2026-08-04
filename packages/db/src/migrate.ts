import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Kysely } from 'kysely';
// Migration APIs live in this subpath, not the root export, as of Kysely 0.29.
import { FileMigrationProvider, type MigrationResult, Migrator } from 'kysely/migration';
import type { Database } from './schema.ts';

/** Where the migration files live, resolved from this file rather than the process's cwd. */
function migrationFolder(): string {
  return path.join(import.meta.dirname, '..', 'migrations');
}

/** Apply every migration that has not run yet.
 *
 * Safe to run concurrently from several processes: Kysely serialises on its
 * `kysely_migration_lock` table, so the loser waits and then finds nothing to do. That is
 * what lets each test package migrate in its own `globalSetup` without coordinating, and
 * what makes migrating during a rolling deploy safe.
 *
 * @returns the migrations applied by this call, in order.
 */
export async function migrateToLatest(database: Kysely<Database>): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationFolder() }),
  });

  const { error, results } = await migrator.migrateToLatest();

  // `results` is populated even on failure, and names which migration broke.
  for (const result of results ?? []) {
    if (result.status === 'Error') {
      console.error(`migration "${result.migrationName}" failed`);
    } else if (result.status === 'Success') {
      console.log(`migration "${result.migrationName}" applied`);
    }
  }

  if (error) throw error;
  return results ?? [];
}
