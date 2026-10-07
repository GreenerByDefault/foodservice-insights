/** The web app's root logger, configured from the environment.
 *
 * Server code calls `logger()` from `./log.ts`, not this, unless what it builds outlives a request.
 * The root lives in a module of its own so the test setup file can replace it while `logger()`
 * itself stays under test.
 */

import { createLogger, type Logger, parseLogSettings } from '@gbd/core/log';
import { LOG_FORMAT, LOG_LEVEL } from '$app/env/private';

let root: Logger | undefined;

/** Built on first use, for the reason `database()` is: the build imports server modules with no
 * env vars set. */
export function rootLogger(): Logger {
  root ??= createLogger(parseLogSettings({ level: LOG_LEVEL, format: LOG_FORMAT }));
  return root;
}
