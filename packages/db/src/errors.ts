/** Telling a database outage apart from a statement Postgres refused.
 *
 * The two arrive as different classes, which is the whole reason this file exists. A statement
 * Postgres replied to — a violated constraint, a cancelled query — comes back as `pg`'s
 * `DatabaseError` carrying a SQLSTATE. A database we never reached, or a connection that died under
 * us, comes back as a bare `Error` from the driver or from Node's socket layer, with no SQLSTATE
 * anywhere. So `instanceof DatabaseError` sees only half of what can go wrong, and the half it
 * misses is every outage.
 */

import { DatabaseError } from 'pg';

/** SQLSTATE class 08, `connection_exception`: every code in it means the connection failed. */
const CONNECTION_EXCEPTION_CLASS = '08';

/** SQLSTATEs where Postgres abandoned a statement it had already accepted, rather than refusing one
 * we sent. Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53200', // out_of_memory
  '53300', // too_many_connections
  '57014', // query_canceled — what `statement_timeout` produces
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '57P05', // idle_session_timeout
]);

/** Node's socket failures, for a database that is unreachable rather than unhappy. */
const TRANSIENT_SYSCALL_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

/** What `pg` raises when a connection fails before Postgres can answer.
 *
 * Matching a message is fragile, and there is nothing else to match: `pg` builds these with
 * `new Error(...)` — no subclass, no `code`, no `name` — in `pg/lib/client.js` and
 * `pg-pool/index.js`. A driver upgrade could rename one and quietly turn every outage back into a
 * 500, so `errors.test.ts` reads the installed driver and asserts each string is still there. That
 * test is the only reason this is exported; it is not part of the package's API.
 */
export const TRANSIENT_DRIVER_MESSAGES: readonly string[] = [
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'Query read timeout',
];

/** Whether a failure means the statement never ran to completion — the database unreachable, the
 * connection dropped, a statement cancelled, a race lost — rather than Postgres refusing what we
 * sent it. Retrying the identical statement can succeed.
 *
 * `'Connection terminated'` without `'unexpectedly'` is deliberately absent: `pg` uses that wording
 * for a connection we asked to close, which is our own shutdown rather than a failure.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof DatabaseError) {
    if (error.code === undefined) return false;
    return (
      error.code.startsWith(CONNECTION_EXCEPTION_CLASS) || TRANSIENT_SQL_STATES.has(error.code)
    );
  }

  if (!(error instanceof Error)) return false;

  const syscall = (error as { code?: unknown }).code;
  if (typeof syscall === 'string' && TRANSIENT_SYSCALL_CODES.has(syscall)) return true;

  return TRANSIENT_DRIVER_MESSAGES.some((message) => error.message.includes(message));
}

/** Whether Postgres refused the statement, so sending it again meets the same answer: a violated
 * constraint, bad SQL, a column that is not there. Kysely rethrows the driver's error unchanged, so
 * a refusal always arrives as a `DatabaseError`.
 */
export function isPermanentDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError && !isTransientDatabaseError(error);
}
