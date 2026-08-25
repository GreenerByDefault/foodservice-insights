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
import { INVOCATION } from './contract/names.ts';
import { shutdown as shutdownDatabase, WORKER_DATABASE } from './db.ts';
import { createWorker } from './worker.ts';

loadLocalEnv();

async function main(): Promise<void> {
  try {
    const config = createWorkerConfig(
      {
        // We add an abbreviated v4 UUID to avoid collisions between workers, e.g. from PID reuse.
        workerId:
          process.env.WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
        runRoot: requireEnv('WORKER_RUN_ROOT'),
        childCommand: {
          executable: requireEnv('PYTHON_BIN'),
          leadingArguments: ['-m', INVOCATION.module],
        },
      },
      { maxConcurrentAttempts: optionalIntEnv('WORKER_MAX_CONCURRENT_ATTEMPTS') },
    );

    if (!(await bucketExists(BLOB_STORE))) {
      throw new Error(
        'The configured S3 bucket does not exist; refusing to start rather than fail every ' +
          'attempt as a missing input file',
      );
    }

    const worker = createWorker({
      db: WORKER_DATABASE,
      store: BLOB_STORE,
      emailer: EMAILER,
      clock: SYSTEM_CLOCK,
      config,
    });

    let draining = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (draining) {
        console.error(`Received ${signal} again while draining; exiting immediately`);
        process.exit(1);
      }
      draining = true;
      console.error(`Received ${signal}; draining`);
      // `run()`'s own `finally` awaits the same memoized drain; this `catch` is only so that an
      // unexpected rejection cannot reach the event loop and kill the process mid-drain.
      void worker.drain().catch((error) => console.error('The drain failed', error));
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
  console.error('Worker exited with an unhandled error', error);
  process.exitCode = 1;
});
