/** The worker's production entrypoint: reads the environment, builds a `WorkerConfig`, and runs
 * `createWorker(...).run()` until a signal or an unrecoverable error ends it. */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadLocalEnv, optionalIntEnv, requireEnv } from '@gbd/core/env';
import { type Database, shutdownDatabase } from '@gbd/db';
import { EMAILER } from '@gbd/email/env';
import { bucketExists } from '@gbd/storage';
import { BLOB_STORE, shutdown as shutdownBlobStore } from '@gbd/storage/env';
import type { Kysely } from 'kysely';
import { SYSTEM_CLOCK } from './clock.ts';
import { createWorkerConfig } from './config.ts';
import {
  initializeCacheDatabase,
  shutdown as shutdownWorkerDatabase,
  WORKER_DATABASE,
} from './db.ts';
import { WORKER_LOG } from './log.ts';
import { resolveWorkerMode } from './modes.ts';
import { resolvePythonBin } from './python-bin.ts';
import { createWorker } from './worker.ts';

loadLocalEnv();

// Without these, Node writes its own multi-line trace to stderr, which a host ingests as one entry
// per line. The destination is synchronous, so the record is written before the exit.
process.on('uncaughtException', (error) => {
  WORKER_LOG.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  WORKER_LOG.fatal({ err: reason }, 'Unhandled rejection');
  process.exit(1);
});

async function main(): Promise<void> {
  // Set only when `CACHE_DB_CONNECTION_STRING` points the cache at a database of its own.
  let separateCacheDb: Kysely<Database> | undefined;
  try {
    const platformShutdownGraceMs = optionalIntEnv('PLATFORM_SHUTDOWN_GRACE_MS');
    const resolved = resolveWorkerMode({
      mode: requireEnv('WORKER_MODE'),
      pythonBin: resolvePythonBin(process.env.PYTHON_BIN),
      openAiApiKey: process.env.OPENAI_API_KEY,
      platformShutdownGraceMs,
      cacheDbConnectionString: process.env.CACHE_DB_CONNECTION_STRING,
    });
    if (resolved.mode === 'off') {
      WORKER_LOG.info('WORKER_MODE=off; not starting a worker.');
      return;
    }

    const config = createWorkerConfig(
      {
        // We add an abbreviated v4 UUID to avoid collisions between workers, e.g. from PID reuse.
        workerId:
          process.env.WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
        runRoot: requireEnv('WORKER_RUN_ROOT'),
        childCommand: resolved.childCommand,
      },
      {
        ...resolved.overrides,
        maxConcurrentAttempts: optionalIntEnv('WORKER_MAX_CONCURRENT_ATTEMPTS'),
        drainGraceMs: optionalIntEnv('WORKER_DRAIN_GRACE_MS'),
        // Unset locally. The image's `ARG` leaves an empty string if a build
        // omits `GIT_SHA`, so empty counts as unset.
        workerGitSha: process.env.WORKER_GIT_SHA || undefined,
      },
      platformShutdownGraceMs,
    );

    if (!(await bucketExists(BLOB_STORE))) {
      throw new Error(
        'The configured S3 bucket does not exist; refusing to start rather than fail every ' +
          'attempt as a missing input file',
      );
    }

    const { cacheDatabase } = resolved;
    if (cacheDatabase.kind === 'separate') {
      separateCacheDb = initializeCacheDatabase(cacheDatabase.connectionString);
    }

    const log = WORKER_LOG.child({ workerId: config.workerId });
    if (cacheDatabase.kind === 'worker' && cacheDatabase.ignoredVariable) {
      log.warn(
        { mode: resolved.mode },
        'Ignoring CACHE_DB_CONNECTION_STRING, which only live honors, so that this mode cannot ' +
          "suggest to a shared cache. The cache is the worker's own database.",
      );
    }
    log.info(
      {
        mode: resolved.mode,
        maxConcurrentAttempts: config.maxConcurrentAttempts,
        workerGitSha: config.workerGitSha,
        cacheDatabase: cacheDatabase.kind === 'separate' ? cacheDatabase.redacted : 'worker',
      },
      'Worker started',
    );
    const worker = createWorker({
      db: WORKER_DATABASE,
      cacheDb: separateCacheDb ?? WORKER_DATABASE,
      store: BLOB_STORE,
      emailer: EMAILER,
      clock: SYSTEM_CLOCK,
      config,
      log,
    });

    let draining = false;
    function onSignal(signal: NodeJS.Signals) {
      if (draining) {
        log.warn({ signal }, 'Received a signal again while draining; exiting immediately');
        process.exit(1);
      }
      draining = true;
      log.info({ signal }, 'Received a signal; draining');
      // `run()`'s own `finally` awaits the same memoized drain; this `catch` is only so that an
      // unexpected rejection cannot reach the event loop and kill the process mid-drain.
      void worker.drain().catch((error) => log.error({ err: error }, 'The drain failed'));
    }
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    await worker.run();
  } finally {
    // There is no emailer shutdown.
    await Promise.all([
      shutdownWorkerDatabase(),
      separateCacheDb && shutdownDatabase(separateCacheDb),
    ]);
    shutdownBlobStore();
  }
}

main().catch((error) => {
  WORKER_LOG.error({ err: error }, 'Worker exited with an unhandled error');
  process.exitCode = 1;
});
