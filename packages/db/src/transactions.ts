import type { Transaction } from 'kysely';
import type { Database, DatabaseExecutor } from './schema.ts';

/** Run `fn` in a transaction, joining `db`'s own if it already is one.
 *
 * Joining rather than nesting is what lets `db` be a rolled-back test transaction: Kysely
 * throws on `db.transaction()` if `db` is already a `Transaction`. See
 * `transactions.integration.test.ts` for the atomicity this buys and its trade-off.
 */
export async function withTransaction<T>(
  db: DatabaseExecutor,
  fn: (transaction: Transaction<Database>) => Promise<T>,
): Promise<T> {
  // `isTransaction` is `true` on `Transaction` and `boolean` on `Kysely`, so it is not narrow
  // enough for TypeScript to discriminate the union — but it is exact enough for the cast.
  if (db.isTransaction) return await fn(db as Transaction<Database>);
  return await db.transaction().execute(fn);
}
