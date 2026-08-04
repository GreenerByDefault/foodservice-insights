/** The database, configured from the environment.
 *
 * **Not for the web app**, which builds its own handle from `$env/dynamic/private` so that
 * SvelteKit owns its configuration — see `apps/web/src/lib/server/db.ts`. This entry point is
 * for everything that runs outside Vite: this package's scripts, its vitest suites, and the
 * worker parent process when it lands.
 *
 * Importing this module connects to a database, so import it only where that is wanted.
 * `TEST_DB=1` selects the test stack.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Kysely } from 'kysely';
import { initializeDatabase, shutdownDatabase } from './client.ts';
import type { Database } from './schema.ts';

loadLocalEnv();

export const DATABASE: Kysely<Database> = initializeDatabase(requireEnv('DB_CONNECTION_STRING'));

/** Close `DATABASE`. Call this at the end of every script, or it will hang. */
export async function shutdown(): Promise<void> {
  await shutdownDatabase(DATABASE);
}
