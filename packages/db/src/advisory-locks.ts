import { sql } from 'kysely';
import type { DatabaseExecutor } from './schema.ts';

/** Every advisory-lock class this package uses, so a lock one module takes can never collide with
 * one taken by another. `pg_advisory_xact_lock` takes two `int4`s — the first namespaces the
 * lock, the second is the key within it — so a class only has to be unique among classes, not
 * among every possible organization or user id.
 *
 * This is the one place that has to know about every class in use: add a new entry here, never
 * reuse one, when another advisory lock is needed. */
export const LOCK_CLASS_ORGANIZATION = 1;
export const LOCK_CLASS_USER = 2;
export const LOCK_CLASS_INVITE_USER = 3;

/**
 * Take a transaction-scoped Postgres advisory lock on `key` within `lockClass`, to serialize a
 * windowed rate-limit decision against every other one racing it.
 *
 * A windowed limit — "N per rolling period" — has no counter column a `CHECK` can cap: a row ages
 * out of the window without any write happening. That means whatever counts rows in the window
 * and whatever then inserts one have to be serialized by hand, or two concurrent writers can each
 * count one under the limit, both decide they're clear, and both insert.
 *
 * Call this first, inside the transaction that will count and then either insert a row or record
 * why it refused to. The lock is transaction-scoped: it releases itself on commit or rollback, so
 * there is nothing to release explicitly, and it's held for exactly as long as the decision it's
 * protecting.
 */
export async function lockRateLimitKey(
  database: DatabaseExecutor,
  lockClass: number,
  key: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${lockClass}, hashtext(${key}))`.execute(database);
}
