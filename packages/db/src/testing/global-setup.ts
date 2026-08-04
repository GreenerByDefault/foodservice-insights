/** vitest `globalSetup` for any package whose tests touch the database.
 *
 * Brings the test database's schema up to date, and nothing else. In particular it does
 * **not** truncate: Turbo runs each package's `test:unit` concurrently against the one test
 * database, so a truncate here would delete rows out from under another package's running
 * tests. Isolation comes from `withRollback` instead.
 */

import { DATABASE, shutdown } from '../env.ts';
import { migrateToLatest } from '../migrate.ts';

export async function setup(): Promise<void> {
  try {
    await migrateToLatest(DATABASE);
  } finally {
    // Vitest runs globalSetup in its own process, separate from the worker
    // processes that run the tests. So this DATABASE pool is private to this
    // process and safe to close here — each test worker imports env.ts itself
    // and opens its own pool, unaffected by this shutdown.
    await shutdown();
  }
}
