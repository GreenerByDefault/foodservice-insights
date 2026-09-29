/** The worker's root logger, configured from the environment.
 *
 * A module singleton for the same reason `WORKER_DATABASE` is one: that pool is built at import,
 * before `main` runs, and logs through this unbound root. Everything else takes a logger as a
 * parameter, which `main.ts` binds to the worker's id.
 */

import { loadLocalEnv } from '@gbd/core/env';
import { createLogger, type Logger, parseLogSettings } from '@gbd/core/log';

loadLocalEnv();

export const WORKER_LOG: Logger = createLogger(
  parseLogSettings({ level: process.env.LOG_LEVEL, format: process.env.LOG_FORMAT }),
);
