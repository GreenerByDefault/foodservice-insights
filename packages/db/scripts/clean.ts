/** CLI for `cleanAllTestDatabases` (see `run-database.ts`). `TEST_DB=1` targets the test stack,
 * though this is the one command that only makes sense there.
 *
 *   pnpm test:db:clean
 *
 * The escape hatch for a template stuck in a bad state (see `run-database.ts`'s note on why
 * `ensureTemplateDatabase` only checks existence) or just for reclaiming disk. Nothing calls this
 * automatically — `sweepStaleRunDatabases` in `apps/web/scripts/test-run.ts` is what runs on
 * every Playwright invocation instead, and it never touches a template.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { cleanAllTestDatabases } from '../src/testing/run-database.ts';

loadLocalEnv();

const dropped = await cleanAllTestDatabases(requireEnv('DB_CONNECTION_STRING'));
if (dropped.length === 0) {
  console.log('nothing to clean');
} else {
  console.log(`dropped ${dropped.length} database(s):\n${dropped.join('\n')}`);
}
