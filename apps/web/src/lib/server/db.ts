import { type Database, initializeDatabase } from '@gbd/db';
import type { Kysely } from 'kysely';
import { env } from '$env/dynamic/private';

/** The web app's database handle.
 *
 * Read at runtime through `$env/dynamic/private`, not `$env/static/private`, so the
 * connection string is not baked into the build. That is what lets one build run against any
 * database — production, staging, or the test stack that Playwright points it at.
 *
 * Route handlers use this directly. Helper functions should instead take a
 * `DatabaseExecutor` parameter, so tests can hand them a rolled-back transaction.
 */
export const DATABASE: Kysely<Database> = initializeDatabase(requireConnectionString());

function requireConnectionString(): string {
  const connectionString = env.DB_CONNECTION_STRING;
  if (connectionString) return connectionString;
  throw new Error(
    'Must set the env var DB_CONNECTION_STRING. Copy .env.example to .env at the repo root ' +
      'and start the database — see the README.',
  );
}
