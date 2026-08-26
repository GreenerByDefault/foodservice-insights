import { sql } from 'kysely';
import type { DatabaseExecutor } from './schema.ts';
import type { OrganizationId, UserId } from './types.ts';

/** Advisory-lock classes this module claims, so a lock it takes can never collide with an
 * unrelated advisory lock elsewhere in the app. `pg_advisory_xact_lock` takes two `int4`s — the
 * first namespaces the lock, the second is the key within it — so a class only has to be unique
 * among classes, not among every possible organization or user id. Add a new class rather than
 * reusing one of these if another advisory lock is ever needed. */
const LOCK_CLASS_ORGANIZATION = 1;
const LOCK_CLASS_USER = 2;

/**
 * Serialize report-rate-limit decisions for one (organization, user) pair against every other
 * upload for that same organization or that same user.
 *
 * The hourly and weekly report limits in REQUIREMENTS.md#abuse-limits are windowed — "N per
 * rolling period" — so, unlike `app_user.organizations_created_count`, there is no counter column
 * a `CHECK` can cap: a report ages out of the window without any write happening. That means
 * whatever counts reports in the window and whatever then inserts one have to be serialized by
 * hand, or two uploads can each count 4 in the window, each decide they're under a limit of 5, and
 * both insert — see `tests/report-rate-limit.test.ts`.
 *
 * Call this first, inside the transaction that will count and then either insert a report or
 * record why it refused to. The lock is transaction-scoped: it releases itself on commit or
 * rollback, so there is nothing to release explicitly, and it's held for exactly as long as the
 * decision it's protecting.
 *
 * Always locks the organization before the user. Every caller must too — two call sites taking
 * these locks in different orders is how two uploads deadlock each other.
 */
export async function lockReportRateLimit(
  database: DatabaseExecutor,
  { organizationId, userId }: { organizationId: OrganizationId; userId: UserId },
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS_ORGANIZATION}, hashtext(${organizationId}))`.execute(
    database,
  );
  await sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS_USER}, hashtext(${userId}))`.execute(
    database,
  );
}

/** How many `report` rows exist for `organizationId`, and separately for `userId`, created within
 * the last `windowSeconds`.
 *
 * The cutoff is computed by Postgres, as `now() - windowSeconds`, not by the caller — `created_at`
 * is itself stamped by Postgres's `now()`, so comparing it against a cutoff from the app server's
 * clock would expose the window boundary to clock skew between the two machines. Computing both
 * ends of the comparison in the database keeps them on one clock.
 *
 * Meaningful only once `lockReportRateLimit` has been called in the same transaction — otherwise
 * this count and whatever it gates can still race. Reports never fall out of the count once
 * created, deleted or not: like `organizations_created_count`, the limit is on reports *created*
 * in the window, not on how many still exist.
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
