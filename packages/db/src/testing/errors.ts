import { sql } from 'kysely';
import { DatabaseError } from 'pg';
import type { DatabaseExecutor } from '../schema.ts';

/** A `pg.DatabaseError`, for tests that simulate Postgres *replying* with a failure without a real
 * connection — a violated constraint, a cancelled statement. Real Postgres errors carry a `code`
 * (see `postgres-codes.ts`); pass one if the test branches on it.
 *
 * This is the wrong factory for an unreachable database. Postgres cannot reply when it is down, so
 * no outage ever arrives as a `DatabaseError` — use `anUnreachableDatabaseError`.
 */
export function aDatabaseError(message = 'a database error', code?: string): DatabaseError {
  const error = new DatabaseError(message, 0, 'error');
  if (code !== undefined) error.code = code;
  return error;
}

/** What a database we cannot reach actually throws. `errors.test.ts` pins this shape against a real
 * connection to a closed port, so it stays a faithful stand-in.
 */
export function anUnreachableDatabaseError(
  message = 'connect ECONNREFUSED 127.0.0.1:5432',
  code = 'ECONNREFUSED',
): Error {
  return Object.assign(new Error(message), { code });
}

/** A genuine Postgres failure, for tests that need Postgres itself — not a stand-in — to refuse a
 * statement. On a transaction, this also leaves it aborted, so a later statement fails too.
 */
export function divideByZero(db: DatabaseExecutor): Promise<unknown> {
  return sql`select 1 / 0`.execute(db);
}
