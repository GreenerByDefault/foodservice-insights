/** Apply pending migrations. `TEST_DB=1` targets the test stack.
 *
 *   pnpm migrate
 *   TEST_DB=1 pnpm migrate
 *
 * Its own handle rather than `@gbd/db/env`'s, for `MIGRATE_DB_LIMITS`.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { MIGRATE_DB_LIMITS } from '../src/budget.ts';
import { initializeDatabase, shutdownDatabase } from '../src/client.ts';
import { lockRetryDelayMs, MIGRATE_ATTEMPTS, migrateToLatest } from '../src/migrate.ts';

loadLocalEnv();

const database = initializeDatabase({
  connectionString: requireEnv('DB_CONNECTION_STRING'),
  sslCa: process.env.DB_SSL_CA,
  applicationName: 'migrate',
  limits: MIGRATE_DB_LIMITS,
  log: 'console',
});

try {
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await migrateToLatest(database);
      if (applied.length === 0) console.log('no pending migrations');
      break;
    } catch (error) {
      const delayMs = lockRetryDelayMs(error, attempt);
      if (delayMs === undefined) throw error;
      console.warn(
        `attempt ${attempt} of ${MIGRATE_ATTEMPTS} timed out waiting for a lock another session ` +
          `holds; retrying in ${delayMs / 1000}s`,
      );
      await sleep(delayMs);
    }
  }
} finally {
  await shutdownDatabase(database);
}
