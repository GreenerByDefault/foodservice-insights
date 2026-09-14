import { sql } from 'kysely';
import { LOCK_CLASS_ORGANIZATION, LOCK_CLASS_USER, lockRateLimitKey } from './advisory-locks.ts';
import type { DatabaseExecutor } from './schema.ts';
import type { OrganizationId, UserId } from './types.ts';

/**
 * Serializes report-rate-limit decisions (the hourly and weekly limits in
 * REQUIREMENTS.md#abuse-limits) for one (organization, user) pair against every other upload for
 * that same organization or that same user — see `lockRateLimitKey` for why a lock is needed at
 * all. See `tests/report-rate-limit.test.ts` for the race this closes.
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
 * the last `windowSeconds`.
 *
 * The cutoff is computed by Postgres, not by the caller, to avoid clock skew.
 *
 * This function should always be preceded by a call to `lockReportRateLimit` in the same
 * transaction to avoid race conditions.
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
