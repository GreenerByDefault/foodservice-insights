import {
  type Database,
  initializeDatabase,
  isPermanentDatabaseError,
  isTransientDatabaseError,
  shutdownDatabase,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import { SERVICE_UNAVAILABLE_ERROR, UNEXPECTED_ERROR_MESSAGE } from '$lib/errors/messages';
import { requireVar } from './env.ts';

let handle: Kysely<Database> | undefined;

/** The web app's database handle, connected on first use.
 *
 * Lazy because the build imports this module to analyse the routes, with no env vars set.
 *
 * Route handlers call this directly. Helper functions should instead take a
 * `DatabaseExecutor` parameter, so tests can hand them a rolled-back transaction.
 */
export function database(): Kysely<Database> {
  handle ??= initializeDatabase({ connectionString: requireVar('DB_CONNECTION_STRING') });
  return handle;
}

/** Release the pool held by `database()`, if one was ever opened. */
export async function closeDatabase(): Promise<void> {
  const opened = handle;
  handle = undefined;
  if (opened) await shutdownDatabase(opened);
}

interface DbCallOptions {
  /** What we were trying to do, for the log line: "Could not reach the database to <action>" or
   * "Unexpected failure to <action>". */
  action: string;
  /** Structured context — entity IDs, etc. — logged next to the error. Never sent to the client. */
  context?: Record<string, unknown>;
}

/** Run a database call, turning a database failure into a logged, generic HTTP error.
 *
 * Anything that is neither transient nor permanent is rethrown: `fn` can fail for reasons that have
 * nothing to do with Postgres, and reporting those as a database problem would hide what actually
 * failed.
 *
 * A caller that *expects* a violation handles it inside `fn` and answers for itself: an `HttpError`
 * is no kind of database failure, so it passes straight back out through here.
 */
export async function withDbErrorHandling<T>(
  fn: () => Promise<T>,
  options: DbCallOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (isTransientDatabaseError(cause)) {
      console.error(`Could not reach the database to ${options.action}`, {
        ...options.context,
        error: cause,
      });
      error(503, SERVICE_UNAVAILABLE_ERROR);
    }
    if (!isPermanentDatabaseError(cause)) throw cause;
    console.error(`Unexpected failure to ${options.action}`, { ...options.context, error: cause });
    error(500, { message: UNEXPECTED_ERROR_MESSAGE });
  }
}
