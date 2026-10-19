/** The worker's own database handle, configured from the environment.
 *
 * A dedicated singleton, rather than `@gbd/db/env`'s, because the worker needs its own pool limits,
 * `WORKER_DB_LIMITS` from `@gbd/db`'s connection budget. `@gbd/db/env` stays the
 * shared handle for scripts and tests that don't need that tuning.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import {
  type Database,
  DEFAULT_LIMITS,
  initializeDatabase,
  shutdownDatabase,
  WORKER_DB_LIMITS,
} from '@gbd/db';
import type { Kysely } from 'kysely';
import { WORKER_LOG } from './log.ts';

loadLocalEnv();

export const WORKER_DATABASE: Kysely<Database> = initializeDatabase({
  connectionString: requireEnv('DB_CONNECTION_STRING'),
  sslCa: process.env.DB_SSL_CA,
  applicationName: 'worker',
  limits: WORKER_DB_LIMITS,
  log: WORKER_LOG,
  siteUrl: process.env.SITE_URL,
});

/** The handle for `CACHE_DB_CONNECTION_STRING`, which only a laptop's
 * `WORKER_MODE=live` worker sets, as
 * `cache_client` on the hosted project.
 *
 * Two connections and none kept while idle, because everyone who holds the role shares its 10
 * (`CACHE_CLIENT_CONNECTION_LIMIT` in `@gbd/db`). No `sslCa`: a hand-composed string carries its
 * own `sslmode` and `sslrootcert`, and `DB_SSL_CA` belongs to the production handles alone. */
export function initializeCacheDatabase(connectionString: string): Kysely<Database> {
  return initializeDatabase({
    connectionString,
    applicationName: 'worker-cache',
    limits: { ...DEFAULT_LIMITS, minConnections: 0, maxConnections: 2 },
    log: WORKER_LOG,
    siteUrl: process.env.SITE_URL,
  });
}

/** Close `WORKER_DATABASE`. Call this at the end of every script, or it will hang. */
export async function shutdown(): Promise<void> {
  await shutdownDatabase(WORKER_DATABASE);
}
