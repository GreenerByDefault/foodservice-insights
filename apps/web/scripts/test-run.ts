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

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgainstFreshStack } from '@gbd/browser-testing/test-run';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { BlobStoreConfig } from '@gbd/storage';

loadLocalEnv();

const PLAYWRIGHT_BIN = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'playwright',
);

function blobStoreConfig(): BlobStoreConfig {
  return {
    endpoint: requireEnv('S3_ENDPOINT'),
    region: requireEnv('S3_REGION'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    bucket: requireEnv('S3_BUCKET'),
  };
}

async function main(): Promise<void> {
  process.exitCode = await runAgainstFreshStack({
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    s3: blobStoreConfig(),
    playwrightBin: PLAYWRIGHT_BIN,
    playwrightArgs: process.argv.slice(2),
  });
}

// Node's default SIGINT/SIGTERM handling exits before `main`'s cleanup runs. Registering a
// handler — even one that does nothing — suppresses that default, so a Ctrl-C still reaches
// `playwright test` (same process group) and `runAgainstFreshStack`'s cleanup still runs once
// that child exits and settles.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

await main();
