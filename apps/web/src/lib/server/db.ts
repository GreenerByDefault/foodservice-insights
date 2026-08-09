import { type Database, initializeDatabase, shutdownDatabase } from '@gbd/db';
import { error } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
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
  handle ??= initializeDatabase(requireVar('DB_CONNECTION_STRING'));
  return handle;
}

/** Release the pool held by `database()`, if one was ever opened. */
export async function closeDatabase(): Promise<void> {
  const opened = handle;
  handle = undefined;
  if (opened) await shutdownDatabase(opened);
}

interface DbCallOptions {
  /** What we were trying to do, for the log line: "Unexpected failure to <action>". */
  action: string;
  /** Structured context — entity IDs, etc. — logged next to the error. Never sent to the client. */
  context?: Record<string, unknown>;
  /** HTTP status returned to the caller. Defaults to 500. */
  status?: number;
  /** Body sent to the caller. Defaults to a message that reveals nothing about the failure. */
  body?: App.Error;
}

/** Run a database call, turning a failure into a logged, generic HTTP error. */
export async function withDbErrorHandling<T>(
  fn: () => Promise<T>,
  options: DbCallOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    console.error(`Unexpected failure to ${options.action}`, { ...options.context, error: cause });
    error(
      options.status ?? 500,
      options.body ?? { message: 'Something went wrong. Please try again.' },
    );
  }
}
