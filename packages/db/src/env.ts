/** The database, configured from the environment.
 *
 * **Not for the web app**, which uses Vite to load env vars. This entry point is
 * for everything else.
 *
 * Importing this module connects to a database, so import it only where that is wanted.
 * `TEST_DB=1` selects the test stack.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Kysely } from 'kysely';
import { initializeDatabase, shutdownDatabase } from './client.ts';
import type { Database } from './schema.ts';

loadLocalEnv();

export const DATABASE: Kysely<Database> = initializeDatabase({
  connectionString: requireEnv('DB_CONNECTION_STRING'),
});

/** Close `DATABASE`. Call this at the end of every script, or it will hang. */
export async function shutdown(): Promise<void> {
  await shutdownDatabase(DATABASE);
}
