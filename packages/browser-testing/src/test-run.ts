/** Spin up a fresh per-run database and blob-store bucket, run Playwright against them, and tear
 * everything down afterward.
 *
 * Both `apps/web/scripts/test-run.ts` and `tests/e2e/scripts/test-run.ts` need this: without it,
 * every `pnpm test:e2e` in every worktree would share one database and bucket and truncate them
 * out from under each other. The one thing a caller supplies beyond a database and a bucket is
 * `beforePlaywright` — whatever else its run needs alive before the browser starts.
 * `tests/e2e` uses it to spawn a worker pointed at the same run database and bucket;
 * `apps/web`'s script passes nothing.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
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

function spawnPlaywright(
  playwrightBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(playwrightBin, ['test', ...args], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** The freshly created resources, handed to `beforePlaywright` so it can point whatever else it
 * starts (e.g. a worker) at the same database and bucket, and give the app's own process the
 * same origin. */
export type FreshStack = {
  connectionString: string;
  s3Bucket: string;
  port: number;
  siteUrl: string;
};

export type BeforePlaywrightResult = {
  /** Merged into Playwright's environment, on top of the current process's own. */
  env?: NodeJS.ProcessEnv;
  /** Runs once Playwright exits, before the run's bucket and database are torn down. */
  afterPlaywright?(): Promise<void>;
};

export type RunAgainstFreshStackOptions = {
  connectionString: string;
  s3: BlobStoreConfig;
  playwrightBin: string;
  playwrightArgs: readonly string[];
  beforePlaywright?(stack: FreshStack): Promise<BeforePlaywrightResult>;
};

/** Returns Playwright's own exit code — assign it straight to `process.exitCode`. */
export async function runAgainstFreshStack(options: RunAgainstFreshStackOptions): Promise<number> {
  const { connectionString, s3, playwrightBin, playwrightArgs, beforePlaywright } = options;

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
      const stack: FreshStack = {
        connectionString: runDatabase.connectionString,
        s3Bucket: runBucket.name,
        port,
        siteUrl: `http://localhost:${port}`,
      };

      const before = (await beforePlaywright?.(stack)) ?? {};
      try {
        return await spawnPlaywright(playwrightBin, playwrightArgs, {
          ...process.env,
          ...before.env,
          DB_CONNECTION_STRING: stack.connectionString,
          S3_BUCKET: stack.s3Bucket,
          SITE_URL: stack.siteUrl,
          PLAYWRIGHT_PORT: String(port),
          TEST_RUN_ID: runDatabase.name,
        });
      } finally {
        await before.afterPlaywright?.();
      }
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
