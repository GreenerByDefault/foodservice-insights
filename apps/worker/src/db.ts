/** The worker's own database handle, configured from the environment.
 *
 * A dedicated singleton, rather than `@gbd/db/env`'s, because the worker needs its own pool limits,
 * `WORKER_DB_LIMITS` from `@gbd/db`'s connection budget. `@gbd/db/env` stays the
 * shared handle for scripts and tests that don't need that tuning.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { type Database, initializeDatabase, shutdownDatabase, WORKER_DB_LIMITS } from '@gbd/db';
import type { Kysely } from 'kysely';
import { WORKER_LOG } from './log.ts';

loadLocalEnv();

export const WORKER_DATABASE: Kysely<Database> = initializeDatabase({
  connectionString: requireEnv('DB_CONNECTION_STRING'),
  limits: WORKER_DB_LIMITS,
  log: WORKER_LOG,
});

/** Close `WORKER_DATABASE`. Call this at the end of every script, or it will hang. */
export async function shutdown(): Promise<void> {
  await shutdownDatabase(WORKER_DATABASE);
}
