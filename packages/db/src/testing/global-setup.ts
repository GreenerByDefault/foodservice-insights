/** vitest `globalSetup` for any package whose tests touch the database.
 *
 * Brings the test database's schema up to date, and nothing else. In particular it does
 * **not** truncate: Turbo runs each package's `test:unit` concurrently against the one test
 * database, so a truncate here would delete rows out from under another package's running
 * tests. Isolation comes from `withRollback` instead. Truncating is for e2e, which commits,
 * and for resetting by hand — see the README.
 */

import { DATABASE, shutdown } from '../env.ts';
import { migrateToLatest } from '../migrate.ts';

export async function setup(): Promise<void> {
  try {
    await migrateToLatest(DATABASE);
  } finally {
    // This process only migrates; the test workers open their own pools.
    await shutdown();
  }
}
