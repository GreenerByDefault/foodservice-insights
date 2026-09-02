/** Wraps `playwright test` via `@gbd/browser-testing/test-run` — see that module for the
 * per-run database/bucket lifecycle, shared with `tests/e2e/scripts/test-run.ts`. This script's
 * own job is just naming the app's env vars and locating its own `playwright` binary; it needs
 * nothing else alive before the browser starts.
 *
 * `pnpm test:e2e`, `test:screenshots`, `test:playwright`, and `screenshots:update` all route
 * through this rather than calling `playwright test` directly — `playwright.config.ts` throws if
 * it detects a bare invocation, via the `TEST_RUN_ID` this sets.
 *
 * Every CLI argument passed to this script is forwarded to `playwright test` verbatim (`--
 * path/to/thing.e2e.ts`, `--project=screenshots`, `--update-snapshots`, ...).
 */

import {
  blobStoreConfigFromEnv,
  installCleanupSignalHandlers,
  resolvePlaywrightBin,
  runAgainstFreshStack,
} from '@gbd/browser-testing/test-run';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';

async function main(): Promise<void> {
  loadLocalEnv();
  installCleanupSignalHandlers();
  process.exitCode = await runAgainstFreshStack({
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    s3: blobStoreConfigFromEnv(),
    playwrightBin: resolvePlaywrightBin(import.meta.url),
    playwrightArgs: process.argv.slice(2),
  });
}

await main();
