import type { Kysely, Transaction } from 'kysely';
import type { default as UsersSchema } from './generated/auth/Users.ts';
import type GeneratedDatabase from './generated/Database.ts';

/** Every table Kysely can query.
 *
 * Add schema-qualified entries like `'auth.users'` here so that cross-schema joins type-check.
 *
 * Hand-written rather than generated, and deliberately outside `generated/`, which Kanel
 * deletes and rewrites on every run.
 */
export interface Database extends GeneratedDatabase {
  'auth.users': UsersSchema;
}

/** What a function that runs queries should accept.
 *
 * Take this rather than the concrete handle, and every such function becomes testable: the
 * app passes its long-lived `Kysely`, and tests pass a `Transaction` that gets rolled back.
 * See `withRollback` in `@gbd/db/testing`.
 */
export type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
