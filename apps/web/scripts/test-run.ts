/** Wraps `playwright test` so every run gets its own database and blob store bucket, instead of
 * every `pnpm test:e2e` in every worktree sharing one and truncating it out from under each
 * other. See `.claude/plans/test-run-isolation.md` for the design this implements.
 *
 * `pnpm test:e2e`, `test:screenshots`, `test:playwright`, and `screenshots:update` all route
 * through this rather than calling `playwright test` directly — `playwright.config.ts` throws if
 * it detects a bare invocation, via the `TEST_RUN_ID` this sets.
 *
 * Every CLI argument passed to this script is forwarded to `playwright test` verbatim (`--
 * path/to/thing.e2e.ts`, `--project=screenshots`, `--update-snapshots`, ...).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { initializeDatabase, shutdownDatabase } from '@gbd/db';
import { seedPlaceholderIdentity } from '@gbd/db/seed';
import {
  createRunDatabase,
  dropRunDatabase,
  ensureTemplateDatabase,
  sweepStaleRunDatabases,
} from '@gbd/db/testing';
import { type BlobStoreConfig, initializeBlobStore, shutdownBlobStore } from '@gbd/storage';
import { createRunBucket, deleteRunBucket, sweepStaleRunBuckets } from '@gbd/storage/testing';

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

/** An OS-assigned free port. A run started between this closing its probe socket and Playwright's
 * `webServer` binding the same number would collide — rare enough locally to accept rather than
 * guard against; a collision fails loudly with `EADDRINUSE`, not silently. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('test-run: could not determine a free port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** Best-effort: a broken sweep should slow a local run down, never break it. Whatever it misses
 * this time, the next run's sweep gets another chance at. */
async function sweepStaleResources(connectionString: string, s3: BlobStoreConfig): Promise<void> {
  try {
    const dropped = await sweepStaleRunDatabases(connectionString);
    if (dropped.length > 0) console.log(`swept ${dropped.length} stale run database(s)`);
  } catch (error) {
    console.warn('test-run: sweeping stale run databases failed, continuing anyway', error);
  }

  const store = initializeBlobStore(s3);
  try {
    const dropped = await sweepStaleRunBuckets(store);
    if (dropped.length > 0) console.log(`swept ${dropped.length} stale run bucket(s)`);
  } catch (error) {
    console.warn('test-run: sweeping stale run buckets failed, continuing anyway', error);
  } finally {
    shutdownBlobStore(store);
  }
}

async function seedRunDatabase(connectionString: string): Promise<void> {
  const database = initializeDatabase({ connectionString });
  try {
    await seedPlaceholderIdentity(database);
  } finally {
    await shutdownDatabase(database);
  }
}

function spawnPlaywright(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(PLAYWRIGHT_BIN, ['test', ...args], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<void> {
  const connectionString = requireEnv('DB_CONNECTION_STRING');
  const s3 = blobStoreConfig();

  await sweepStaleResources(connectionString, s3);

  const templateName = await ensureTemplateDatabase(connectionString);
  const runDatabase = await createRunDatabase(connectionString, templateName);
  try {
    await seedRunDatabase(runDatabase.connectionString);

    const store = initializeBlobStore(s3);
    let runBucket: Awaited<ReturnType<typeof createRunBucket>> | undefined;
    try {
      runBucket = await createRunBucket(store);
    } finally {
      shutdownBlobStore(store);
    }

    try {
      const port = await freePort();
      process.exitCode = await spawnPlaywright(process.argv.slice(2), {
        ...process.env,
        DB_CONNECTION_STRING: runDatabase.connectionString,
        S3_BUCKET: runBucket.name,
        SITE_URL: `http://localhost:${port}`,
        PLAYWRIGHT_PORT: String(port),
        TEST_RUN_ID: runDatabase.name,
      });
    } finally {
      // Best-effort, like the sweep above: a run whose result already printed shouldn't fail on
      // its own cleanup. `sweepStaleRunBuckets` picks up whatever this misses.
      await deleteRunBucket(runBucket.store).catch((error: unknown) => {
        console.warn(`test-run: could not delete run bucket ${runBucket?.name}`, error);
      });
    }
  } finally {
    // Same reasoning as the bucket: `sweepStaleRunDatabases` is the backstop. This one usually
    // succeeds even on a hard kill, since Playwright's own webServer teardown — not this
    // process — is what closes the pool holding the run database's last connection.
    await dropRunDatabase(connectionString, runDatabase.name).catch((error: unknown) => {
      console.warn(`test-run: could not drop run database ${runDatabase.name}`, error);
    });
  }
}

// Node's default SIGINT/SIGTERM handling exits before `main`'s `finally` blocks run. Registering
// a handler — even one that does nothing — suppresses that default, so a Ctrl-C still reaches
// `playwright test` (same process group) and this process's cleanup still runs once that child
// exits and `spawnPlaywright`'s promise settles.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

await main();
