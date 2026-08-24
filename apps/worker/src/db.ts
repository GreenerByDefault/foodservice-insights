/** The worker's own database handle, configured from the environment.
 *
 * A dedicated singleton, rather than `@gbd/db/env`'s, because the worker needs pool limits tuned
 * to its own connection budget instead of `@gbd/db`'s defaults. `@gbd/db/env` stays the
 * shared handle for scripts and tests that don't need that tuning.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import {
  type Database,
  type DatabaseLimits,
  DEFAULT_LIMITS,
  initializeDatabase,
  shutdownDatabase,
} from '@gbd/db';
import type { Kysely } from 'kysely';

loadLocalEnv();

// TODO: Tune these away from @gbd/db's defaults once the worker's connection budget is measured.
export const WORKER_DB_LIMITS: DatabaseLimits = DEFAULT_LIMITS;

export const WORKER_DATABASE: Kysely<Database> = initializeDatabase({
  connectionString: requireEnv('DB_CONNECTION_STRING'),
  limits: WORKER_DB_LIMITS,
});

/** Close `WORKER_DATABASE`. Call this at the end of every script, or it will hang. */
export async function shutdown(): Promise<void> {
  await shutdownDatabase(WORKER_DATABASE);
}
