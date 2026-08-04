import { type Database, initializeDatabase, shutdownDatabase } from '@gbd/db';
import type { Kysely } from 'kysely';
import { env } from '$env/dynamic/private';

let handle: Kysely<Database> | undefined;

/** The web app's database handle, connected on first use.
 *
 * Lazy because the build imports this module to analyse the routes, with no env vars set.
 *
 * Route handlers call this directly. Helper functions should instead take a
 * `DatabaseExecutor` parameter, so tests can hand them a rolled-back transaction.
 */
export function database(): Kysely<Database> {
  handle ??= initializeDatabase(requireConnectionString());
  return handle;
}

/** Release the pool held by `database()`, if one was ever opened. */
export async function closeDatabase(): Promise<void> {
  const opened = handle;
  handle = undefined;
  if (opened) await shutdownDatabase(opened);
}

function requireConnectionString(): string {
  const connectionString = env.DB_CONNECTION_STRING;
  if (connectionString) return connectionString;
  throw new Error(
    'Must set the env var DB_CONNECTION_STRING. Copy .env.example to .env at the repo root ' +
      'and start the database — see the README.',
  );
}
