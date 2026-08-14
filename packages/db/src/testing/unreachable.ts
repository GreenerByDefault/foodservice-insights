import type { Kysely } from 'kysely';
import { initializeDatabase } from '../client.ts';
import type { Database } from '../schema.ts';

/** A database handle aimed at a port nothing listens on, so every call fails fast with a real
 * unreachable-database error — for tests that need a database to genuinely be unreachable, not a
 * mock. Port 1 is reserved and unused, so the connection is refused immediately rather than
 * hanging until the pool's connection timeout; `errors.test.ts` pins that this arrives as the same
 * shape `anUnreachableDatabaseError` fakes.
 */
export function unreachableDatabase(): Kysely<Database> {
  return initializeDatabase('postgres://nobody:nothing@127.0.0.1:1/nothing');
}
