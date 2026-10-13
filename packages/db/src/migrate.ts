import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, type MigrationResult, Migrator } from 'kysely/migration';
import { DatabaseError } from 'pg';
import { POSTGRES_CODE_LOCK_NOT_AVAILABLE } from './postgres-codes.ts';
import type { Database } from './schema.ts';

function migrationFolder(): string {
  return path.join(import.meta.dirname, '..', 'migrations');
}

/** Apply every migration that has not run yet, all in one transaction.
 *
 * Safe to run concurrently from several processes: Kysely serialises them on a session-level
 * advisory lock, so the loser waits and then finds nothing to do.
 *
 * @returns the migrations applied by this call, in order.
 */
export async function migrateToLatest(database: Kysely<Database>): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationFolder() }),
  });

  const { error, results } = await migrator.migrateToLatest();

  // `results` is populated even on failure, and names which migration broke. Every migration runs
  // in one transaction, so a failure rolls back the ones Kysely reports as `Success` before it.
  for (const result of results ?? []) {
    if (result.status === 'Error') {
      console.error(`migration "${result.migrationName}" failed`);
    } else if (result.status === 'Success' && !error) {
      console.log(`migration "${result.migrationName}" applied`);
    }
  }

  if (error) throw error;
  return results ?? [];
}

export const MIGRATE_ATTEMPTS = 5;
export const MIGRATE_RETRY_DELAY_MS = 5_000;

/** How long to wait before running the migrations again after `failedAttempt` (1-based) threw
 * `error`, or `undefined` to give up.
 *
 * Only a `lock_timeout` is retried: the whole run rolled back without changing anything, and the
 * transaction holding the lock is likely to have finished by the next attempt. Anything else, a
 * broken migration or an outage, fails the deploy for a human to look at.
 */
export function lockRetryDelayMs(error: unknown, failedAttempt: number): number | undefined {
  const lockTimedOut =
    error instanceof DatabaseError && error.code === POSTGRES_CODE_LOCK_NOT_AVAILABLE;
  return lockTimedOut && failedAttempt < MIGRATE_ATTEMPTS ? MIGRATE_RETRY_DELAY_MS : undefined;
}
