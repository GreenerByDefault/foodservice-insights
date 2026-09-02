/** Wraps `playwright test` via `@gbd/browser-testing/test-run` — see that module for the per-run
 * database/bucket lifecycle, shared with `apps/web/scripts/test-run.ts`. What this suite adds is
 * everything the *system* tier needs alive before the browser starts: a real worker pointed at the
 * run's database and bucket, and a mailbox only this run sends to.
 *
 * `pnpm test:system` routes through this rather than calling `playwright test` directly —
 * `playwright.config.ts` throws if it detects a bare invocation, via the `TEST_RUN_ID` this sets.
 *
 * Every CLI argument passed to this script is forwarded to `playwright test` verbatim.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BeforePlaywrightResult,
  type FreshStack,
  runAgainstFreshStack,
} from '@gbd/browser-testing/test-run';
import { findRepoRoot, loadLocalEnv, requireEnv } from '@gbd/core/env';
import { initializeDatabase, shutdownDatabase } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import { aTestEmailAddress } from '@gbd/email/testing';
import type { BlobStoreConfig } from '@gbd/storage';

loadLocalEnv();

const REPO_ROOT = findRepoRoot();

const PLAYWRIGHT_BIN = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'playwright',
);

/** Node 24 runs TypeScript directly, so there is no build step between here and the real worker —
 * the same entrypoint, spawned the same way, as `apps/worker`'s own `dev` script. */
const WORKER_ENTRYPOINT = path.join(REPO_ROOT, 'apps', 'worker', 'src', 'main.ts');

/** How long a drain gets after SIGTERM before we stop being polite. Comfortably above the
 * `stubbed` profile's `killGraceMs` of 5s, so a worker still killing a child is not cut off
 * mid-teardown. */
const WORKER_SHUTDOWN_TIMEOUT_MS = 15_000;

function blobStoreConfig(): BlobStoreConfig {
  return {
    endpoint: requireEnv('S3_ENDPOINT'),
    region: requireEnv('S3_REGION'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    bucket: requireEnv('S3_BUCKET'),
  };
}

/** Route this run's notifications to an address nothing else will send to.
 *
 * `identifyUser` is a phase-one stand-in that always resolves to `PLACEHOLDER_USER_ID`, so every
 * attempt this run creates carries it as `requestedByUserId`, and the worker's notification sweep
 * joins `analysisAttempt -> appUser -> auth.users.email` to find the recipient. Overwriting that
 * one row is therefore what isolates this run's mail. It has to happen here rather than in a spec:
 * Mailpit is shared across concurrent runs and worktrees, `seedPlaceholderIdentity` inserts
 * `ON CONFLICT DO NOTHING` so it leaves the fixed `PLACEHOLDER_USER_EMAIL` in place, and the real
 * worker — unlike the sweep's own tests — never narrows to a candidate list.
 */
async function useAFreshNotificationAddress(connectionString: string): Promise<string> {
  const address = aTestEmailAddress('system-e2e');
  const database = initializeDatabase({ connectionString });
  try {
    await database
      .updateTable('auth.users')
      .set({ email: address })
      .where('id', '=', PLACEHOLDER_USER_ID)
      .execute();
  } finally {
    await shutdownDatabase(database);
  }
  return address;
}

function waitForExit(worker: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      resolve();
      return;
    }
    worker.once('exit', () => resolve());
  });
}

/** The worker has to be its own process, not an in-process import: `apps/worker/src/db.ts`,
 * `@gbd/storage/env` and `@gbd/email/env` all read their environment at *import* time, so the run's
 * database and bucket have to be in place before the module graph loads. `WORKER_MODE`,
 * `PYTHON_BIN` and the `EMAIL_*` values come from `.env.test` through the inherited environment —
 * `loadLocalEnv` lets an already-set variable win over the file, so what we set here survives.
 */
function startWorker(stack: FreshStack, runRoot: string): { stop(): Promise<void> } {
  const worker = spawn(process.execPath, [WORKER_ENTRYPOINT], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DB: '1',
      DB_CONNECTION_STRING: stack.connectionString,
      S3_BUCKET: stack.s3Bucket,
      SITE_URL: stack.siteUrl,
      WORKER_RUN_ROOT: runRoot,
    },
  });

  // The worker logs nothing on a successful start, so there is no readiness line to wait for — and
  // a worker that dies at startup (an absent bucket, an unusable PYTHON_BIN) would otherwise show
  // up only as an opaque assertion timeout a minute into the first spec. `stopping` is what tells
  // that apart from the shutdown below, where the worker drains and exits 0 under its own power
  // rather than dying from the signal.
  let stopping = false;
  worker.on('exit', (code) => {
    if (stopping) return;
    console.error(`test-run: the worker exited on its own with code ${code}; specs will now fail`);
  });

  return {
    stop: async () => {
      stopping = true;
      worker.kill('SIGTERM');
      const timeout = new Promise<'timed-out'>((resolve) => {
        setTimeout(() => resolve('timed-out'), WORKER_SHUTDOWN_TIMEOUT_MS).unref();
      });
      if ((await Promise.race([waitForExit(worker), timeout])) === 'timed-out') {
        console.warn('test-run: the worker did not drain in time; killing it');
        worker.kill('SIGKILL');
        await waitForExit(worker);
      }
    },
  };
}

async function startWorkerAndMailbox(stack: FreshStack): Promise<BeforePlaywrightResult> {
  const notificationEmail = await useAFreshNotificationAddress(stack.connectionString);
  const runRoot = await mkdtemp(path.join(tmpdir(), 'gbd-system-e2e-'));
  const worker = startWorker(stack, runRoot);

  return {
    env: { RUN_NOTIFICATION_EMAIL: notificationEmail },
    afterPlaywright: async () => {
      await worker.stop();
      await rm(runRoot, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  process.exitCode = await runAgainstFreshStack({
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    s3: blobStoreConfig(),
    playwrightBin: PLAYWRIGHT_BIN,
    playwrightArgs: process.argv.slice(2),
    beforePlaywright: startWorkerAndMailbox,
  });
}

// Node's default SIGINT/SIGTERM handling exits before `main`'s cleanup runs. Registering a
// handler — even one that does nothing — suppresses that default, so a Ctrl-C still reaches
// `playwright test` (same process group) and `runAgainstFreshStack`'s cleanup still runs once
// that child exits and settles.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

await main();
