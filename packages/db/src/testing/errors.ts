import { DatabaseError } from 'pg';

/** A `pg.DatabaseError`, for tests that simulate a database failure without a real connection —
 * e.g. a mocked call that a caller of `isDatabaseError` should treat as one. Real Postgres
 * errors carry a `code` (see `postgres-codes.ts`); pass one if the test branches on it.
 */
export function aDatabaseError(message = 'a database error', code?: string): DatabaseError {
  const error = new DatabaseError(message, 0, 'error');
  if (code !== undefined) error.code = code;
  return error;
}
