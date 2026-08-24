/** The worker's production entrypoint: reads the environment, builds a `WorkerConfig`, and runs
 * `createWorker(...).run()` until a signal or an unrecoverable error ends it.
 *
 * Nothing here belongs in `dist/testing/` — `tsconfig.build.json` excludes `src/testing/**`, and
 * this file is the only thing that runs in production.
 */

import { hostname } from 'node:os';
import { loadLocalEnv, optionalIntEnv, requireEnv } from '@gbd/core/env';
import { uuidV7 } from '@gbd/db';
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
        // `hostname()` + `pid` alone repeats across a quick container restart that reuses both,
        // which is exactly the collision `reap`'s "excluding our own worker_id" logic depends on
        // not happening.
        workerId: process.env.WORKER_ID ?? `${hostname()}-${process.pid}-${uuidV7().slice(0, 8)}`,
        runRoot: requireEnv('WORKER_RUN_ROOT'),
        childCommand: {
          executable: requireEnv('PYTHON_BIN'),
          leadingArguments: ['-m', INVOCATION.module],
        },
      },
      { maxConcurrentAttempts: optionalIntEnv('WORKER_MAX_CONCURRENT_ATTEMPTS') },
    );

    // A wrong `S3_BUCKET` otherwise reads as "every input file missing" on every attempt, rather
    // than as the configuration error it actually is.
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
      void worker.drain();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    await worker.run();
  } finally {
    // There is no emailer shutdown: `@gbd/email/env`'s own header says why.
    await shutdownDatabase();
    shutdownBlobStore();
  }
}

main().catch((error) => {
  console.error('Worker exited with an unhandled error', error);
  process.exitCode = 1;
});
