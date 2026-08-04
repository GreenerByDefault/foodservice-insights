import type { Kysely, Transaction } from 'kysely';
import type GeneratedDatabase from './generated/Database.ts';

/** Every table Kysely can query.
 *
 * Hand-written rather than generated, and deliberately outside `generated/`, which kanel
 * deletes and rewrites on every run. Once Supabase Auth lands this is also where
 * schema-qualified entries like `'auth.users'` go, so cross-schema joins type-check.
 */
export type Database = GeneratedDatabase;

/** What a function that runs queries should accept.
 *
 * Take this rather than the concrete handle, and every such function becomes testable: the
 * app passes its long-lived `Kysely`, and tests pass a `Transaction` that gets rolled back.
 * See `withRollback` in `@gbd/db/testing`.
 */
export type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
