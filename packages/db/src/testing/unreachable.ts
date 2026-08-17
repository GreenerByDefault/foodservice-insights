import { LOCALHOST, UNREACHABLE_PORT } from '@gbd/core/testing';
import type { Kysely } from 'kysely';
import { initializeDatabase } from '../client.ts';
import type { Database } from '../schema.ts';

/** A database that fails fast with a real unreachable-database error. */
export function unreachableDatabase(): Kysely<Database> {
  return initializeDatabase(`postgres://nobody:nothing@${LOCALHOST}:${UNREACHABLE_PORT}/nothing`);
}
