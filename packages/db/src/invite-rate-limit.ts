import { sql } from 'kysely';
import { LOCK_CLASS_INVITE_USER, lockRateLimitKey } from './advisory-locks.ts';
import type { DatabaseExecutor } from './schema.ts';
import type { UserId } from './types.ts';

/**
 * Serializes invite-rate-limit decisions (`HOURLY_INVITE_LIMIT` in
 * `apps/web/src/lib/invites/limits.ts`) for one inviting user against every other invite they
 * send — see `lockRateLimitKey` for why a lock is needed at all. See
 * `tests/invite-rate-limit.test.ts` for the race this closes.
 */
export async function lockInviteRateLimit(
  database: DatabaseExecutor,
  { userId }: { userId: UserId },
): Promise<void> {
  await lockRateLimitKey(database, LOCK_CLASS_INVITE_USER, userId);
}

/** How many `organization_invite` rows `userId` has sent, as `invited_by_user_id`, within the
 * last `windowSeconds` — including superseded ones, which still sent mail and so still count
 * against the limit.
 *
 * The cutoff is computed by Postgres, not by the caller, to avoid clock skew.
 *
 * This function should always be preceded by a call to `lockInviteRateLimit` in the same
 * transaction to avoid race conditions.
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
