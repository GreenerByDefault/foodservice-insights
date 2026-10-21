/**
 * Advisory locks and windowed counts behind the abuse limits: reports per organization and user
 * (docs/requirements.md#abuse-limits) and invites per inviting user.
 *
 * A windowed limit — "N per rolling period" — has no counter column a `CHECK` can cap: a row ages
 * out of the window without any write happening. So whatever counts rows in the window and
 * whatever then inserts one have to be serialized by hand, or two concurrent writers can each
 * count one under the limit, both decide they're clear, and both insert.
 *
 * Each limit exports a `lock*` and a `count*Since`. Call the lock first, inside the transaction
 * that will count and then either insert a row or record why it refused to. The lock is
 * transaction-scoped: it releases itself on commit or rollback, and is held for exactly as long as
 * the decision it protects. Postgres computes the window's cutoff, not the caller, to avoid clock
 * skew.
 */

import { sql } from 'kysely';
import type { DatabaseExecutor } from './schema.ts';
import type { OrganizationId, UserId } from './types.ts';

/** Every advisory-lock class this package uses, so a lock one limit takes can never collide with
 * one taken by another. `pg_advisory_xact_lock` takes two `int4`s — the first namespaces the
 * lock, the second is the key within it — so a class only has to be unique among classes, not
 * among every possible organization or user id.
 *
 * Add a new entry here, never reuse one, when another advisory lock is needed. */
const LOCK_CLASS_ORGANIZATION = 1;
const LOCK_CLASS_USER = 2;
const LOCK_CLASS_INVITE_USER = 3;

async function lockRateLimitKey(
  database: DatabaseExecutor,
  lockClass: number,
  key: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${lockClass}, hashtext(${key}))`.execute(database);
}

/**
 * Serializes report-rate-limit decisions (the hourly and weekly limits in
 * docs/requirements.md#abuse-limits) for one (organization, user) pair against every other upload for
 * that same organization or that same user.
 *
 * Always locks the organization before the user. Every caller must too — two call sites taking
 * these locks in different orders is how two uploads deadlock each other.
 */
export async function lockReportRateLimit(
  database: DatabaseExecutor,
  { organizationId, userId }: { organizationId: OrganizationId; userId: UserId },
): Promise<void> {
  await lockRateLimitKey(database, LOCK_CLASS_ORGANIZATION, organizationId);
  await lockRateLimitKey(database, LOCK_CLASS_USER, userId);
}

/** How many `report` rows exist for `organizationId`, and separately for `userId`, created within
 * the last `windowSeconds`. Call `lockReportRateLimit` first, in the same transaction.
 */
export async function countReportsSince(
  database: DatabaseExecutor,
  {
    organizationId,
    userId,
    windowSeconds,
  }: { organizationId: OrganizationId; userId: UserId; windowSeconds: number },
): Promise<{ organizationCount: number; userCount: number }> {
  const since = sql<Date>`now() - make_interval(secs => ${windowSeconds})`;

  const organizationRow = await database
    .selectFrom('report')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('organizationId', '=', organizationId)
    .where('createdAt', '>=', since)
    .executeTakeFirstOrThrow();

  const userRow = await database
    .selectFrom('report')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('createdByUserId', '=', userId)
    .where('createdAt', '>=', since)
    .executeTakeFirstOrThrow();

  return { organizationCount: Number(organizationRow.count), userCount: Number(userRow.count) };
}

/**
 * Serializes invite-rate-limit decisions (`HOURLY_INVITE_LIMIT` in
 * `apps/web/src/lib/server/invites/limits.ts`) for one inviting user against every other invite
 * they send.
 */
export async function lockInviteRateLimit(
  database: DatabaseExecutor,
  { userId }: { userId: UserId },
): Promise<void> {
  await lockRateLimitKey(database, LOCK_CLASS_INVITE_USER, userId);
}

/** How many `organization_invite` rows `userId` has sent, as `invited_by_user_id`, within the
 * last `windowSeconds` — including superseded ones, which still sent mail and so still count
 * against the limit. Call `lockInviteRateLimit` first, in the same transaction.
 */
export async function countInvitesSince(
  database: DatabaseExecutor,
  { userId, windowSeconds }: { userId: UserId; windowSeconds: number },
): Promise<number> {
  const since = sql<Date>`now() - make_interval(secs => ${windowSeconds})`;

  const row = await database
    .selectFrom('organizationInvite')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('invitedByUserId', '=', userId)
    .where('createdAt', '>=', since)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}
