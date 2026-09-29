/** The worker's production entrypoint: reads the environment, builds a `WorkerConfig`, and runs
 * `createWorker(...).run()` until a signal or an unrecoverable error ends it. */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadLocalEnv, optionalIntEnv, requireEnv } from '@gbd/core/env';
import { EMAILER } from '@gbd/email/env';
import { bucketExists } from '@gbd/storage';
import { BLOB_STORE, shutdown as shutdownBlobStore } from '@gbd/storage/env';
import { SYSTEM_CLOCK } from './clock.ts';
import { createWorkerConfig } from './config.ts';
import { shutdown as shutdownDatabase, WORKER_DATABASE } from './db.ts';
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
  try {
    const resolved = resolveWorkerMode({
      mode: requireEnv('WORKER_MODE'),
      pythonBin: resolvePythonBin(process.env.PYTHON_BIN),
    });
    if (resolved.mode === 'off') {
      WORKER_LOG.error('WORKER_MODE=off; not starting a worker.');
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
      },
      optionalIntEnv('PLATFORM_SHUTDOWN_GRACE_MS'),
    );

    if (!(await bucketExists(BLOB_STORE))) {
      throw new Error(
        'The configured S3 bucket does not exist; refusing to start rather than fail every ' +
          'attempt as a missing input file',
      );
    }

    const log = WORKER_LOG.child({ workerId: config.workerId });
    const worker = createWorker({
      db: WORKER_DATABASE,
      store: BLOB_STORE,
      emailer: EMAILER,
      clock: SYSTEM_CLOCK,
      config,
      log,
    });

    let draining = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (draining) {
        log.error({ signal }, 'Received a signal again while draining; exiting immediately');
        process.exit(1);
      }
      draining = true;
      log.error({ signal }, 'Received a signal; draining');
      // `run()`'s own `finally` awaits the same memoized drain; this `catch` is only so that an
      // unexpected rejection cannot reach the event loop and kill the process mid-drain.
      void worker.drain().catch((error) => log.error({ err: error }, 'The drain failed'));
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    await worker.run();
  } finally {
    // There is no emailer shutdown.
    await shutdownDatabase();
    shutdownBlobStore();
  }
}

main().catch((error) => {
  WORKER_LOG.error({ err: error }, 'Worker exited with an unhandled error');
  process.exitCode = 1;
});
