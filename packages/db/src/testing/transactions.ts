import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../schema.ts';

/** Thrown to force a rollback. Never escapes `withRollback`. */
const ROLLBACK = 'Rollback transaction';

/** Run `fn` in a transaction that is always rolled back, however the test ends.
 *
 * This is how database tests stay isolated and repeatable without truncating between them,
 * which in turn is what lets test files run concurrently against one database. Take the
 * transaction it hands you and pass it to the code under test as its `DatabaseExecutor`.
 *
 * `database` is a parameter rather than a module-level singleton so each caller uses the
 * handle it already has, instead of opening a second pool against the same database.
 */
export async function withRollback<T>(
  database: Kysely<Database>,
  fn: (transaction: Transaction<Database>) => Promise<T>,
): Promise<T> {
  // Wrapped rather than a bare `T`, so `undefined` is distinguishable from "never ran" even
  // when `fn` legitimately returns undefined.
  let outcome: { value: T } | undefined;
  try {
    await database.transaction().execute(async (transaction) => {
      outcome = { value: await fn(transaction) };
      // Kysely rolls back when the callback throws, and there is no other way to ask it to.
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    // Anything else is a real failure — including a failed assertion, which still rolled back.
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }

  if (!outcome) throw new Error('withRollback: the transaction body never completed');
  return outcome.value;
}
