import { sql } from 'kysely';
import type { DatabaseExecutor } from './schema.ts';
import type { UserId } from './types.ts';

/** Advisory-lock class this module claims, so a lock it takes can never collide with an
 * unrelated advisory lock elsewhere in the app. `report-rate-limit.ts` claims classes 1 and 2 —
 * add a new class rather than reusing one of those, or either of these, if another advisory lock
 * is ever needed. */
const LOCK_CLASS_INVITE_USER = 3;

/**
 * Serialize invite-rate-limit decisions for one inviting user against every other invite they
 * send.
 *
 * `HOURLY_INVITE_LIMIT` (`apps/web/src/lib/invites/limits.ts`) is windowed — "N per rolling
 * hour" — so there is no counter column a `CHECK` can cap: an invite ages out of the window
 * without any write happening. That means whatever counts invites in the window and whatever
 * then inserts one have to be serialized by hand, or two concurrent invites can each count
 * limit − 1, both decide they're under the limit, and both insert — see
 * `tests/invite-rate-limit.test.ts`.
 *
 * Call this first, inside the transaction that will count and then either insert an invite or
 * record why it refused to. The lock is transaction-scoped: it releases itself on commit or
 * rollback, so there is nothing to release explicitly, and it's held for exactly as long as the
 * decision it's protecting.
 */
export async function lockInviteRateLimit(
  database: DatabaseExecutor,
  { userId }: { userId: UserId },
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS_INVITE_USER}, hashtext(${userId}))`.execute(
    database,
  );
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
