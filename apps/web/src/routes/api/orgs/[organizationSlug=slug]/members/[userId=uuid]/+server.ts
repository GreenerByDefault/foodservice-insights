import { type DatabaseExecutor, type OrganizationId, type UserId, withTransaction } from '@gbd/db';
import { error, json } from '@sveltejs/kit';
import { sql } from 'kysely';
import * as v from 'valibot';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth, requireOrganizationAdmin } from '$lib/server/auth/guards';
import { requireOrganizationRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { database, isCheckViolation, withDbErrorHandling } from '$lib/server/db';
import type { RequestHandler } from './$types';

const ChangeRoleBodySchema = v.object({ role: v.picklist(['admin', 'member']) });

/** Promote or demote. Admin only. */
export const PATCH: RequestHandler = async (event) => {
  const { organizationId, actor } = await requireOrganizationRouteContext(database(), event, {
    admin: true,
  });

  return await _changeMemberRole(
    database(),
    { organizationId, actor, targetUserId: event.params.userId as UserId },
    await event.request.json(),
  );
};

/** Remove a member, or leave — the same request with your own id, which is why this is not two
 * endpoints. An admin may do either; a member may only do the second, so a request for anyone
 * else's id first re-checks admin (403 for a member).
 */
export const DELETE: RequestHandler = async (event) => {
  const { organizationId, actor } = await requireOrganizationRouteContext(database(), event);
  const targetUserId = event.params.userId as UserId;

  if (targetUserId !== actor.userId) {
    await requireOrganizationAdmin(
      database(),
      requireAuth(event.locals),
      event.params.organizationSlug,
    );
  }

  return await _removeMember(database(), { organizationId, actor, targetUserId });
};

/** Promote or demote `targetUserId` to `role`, from `body`'s `{ role }`.
 *
 * - 400 for a body that isn't `{ role: 'admin' | 'member' }`.
 * - 404 if `targetUserId` isn't a member of `organizationId` — `App.Error`'s `code` already
 *   carries `'not_found'`, so this goes through `error()` like every other route's 404.
 * - 204 with no audit row if the role is already `role` — a no-op is not a role change.
 * - 409 `last-admin` if this would leave the organization with no admin —
 *   `organization_member_at_least_one_admin` decides, not this function. `SET CONSTRAINTS …
 *   IMMEDIATE` moves its check from `COMMIT` onto the `UPDATE` itself, so it can be caught here
 *   with a `try`, and so it actually fires when a test calls this inside `withRollback`, which
 *   never commits. `last-admin` is this route's own code, not `App.Error`'s, so this is a `json()`
 *   response built after the transaction settles, the same way `nameTakenResponse` answers a
 *   collision — not a caught-and-rethrown `error()`.
 */
export async function _changeMemberRole(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; actor: Actor; targetUserId: UserId },
  body: unknown,
): Promise<Response> {
  const { organizationId, actor, targetUserId } = params;

  const parsedBody = v.safeParse(ChangeRoleBodySchema, body);
  if (!parsedBody.success) {
    return json({ message: 'Fix the highlighted field.' }, { status: 400 });
  }
  const { role } = parsedBody.output;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        await sql`SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE`.execute(
          transaction,
        );

        const member = await transaction
          .selectFrom('organizationMember')
          .select('role')
          .where('organizationId', '=', organizationId)
          .where('userId', '=', targetUserId)
          .forUpdate()
          .executeTakeFirst();

        if (!member) error(404, { message: 'Not found', code: 'not_found' });
        if (member.role === role) return { ok: true as const };

        try {
          await transaction
            .updateTable('organizationMember')
            .set({ role })
            .where('organizationId', '=', organizationId)
            .where('userId', '=', targetUserId)
            .execute();
        } catch (cause) {
          if (isCheckViolation(cause, 'organization_member_at_least_one_admin')) {
            return { ok: false as const };
          }
          throw cause;
        }

        await recordAuditEvent(transaction, {
          action: 'member.role_changed',
          actor,
          target: { type: 'user', id: targetUserId, organizationId },
          detail: { role },
        });

        return { ok: true as const };
      }),
    { action: 'change a member’s role', context: { organizationId, targetUserId } },
  );

  if (!outcome.ok) {
    return json(
      {
        message: "You're the only admin. Make someone else an admin first.",
        code: 'last-admin',
      },
      { status: 409 },
    );
  }
  return new Response(null, { status: 204 });
}

/** Remove `targetUserId` from `organizationId` — or leave, when it's `actor`'s own id.
 *
 * - 404 if `targetUserId` isn't a member of `organizationId`.
 * - 409 `last-admin` if this would leave the organization with no admin —
 *   `organization_member_at_least_one_admin` decides, not this function, the same way and for the
 *   same reason as `_changeMemberRole`.
 * - Otherwise `member.left` when `targetUserId` is `actor` else `member.removed`, then 204.
 */
export async function _removeMember(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; actor: Actor; targetUserId: UserId },
): Promise<Response> {
  const { organizationId, actor, targetUserId } = params;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        await sql`SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE`.execute(
          transaction,
        );

        try {
          const removed = await transaction
            .deleteFrom('organizationMember')
            .where('organizationId', '=', organizationId)
            .where('userId', '=', targetUserId)
            .returning('userId')
            .executeTakeFirst();

          if (!removed) error(404, { message: 'Not found', code: 'not_found' });
        } catch (cause) {
          if (isCheckViolation(cause, 'organization_member_at_least_one_admin')) {
            return { ok: false as const };
          }
          throw cause;
        }

        await recordAuditEvent(transaction, {
          action: targetUserId === actor.userId ? 'member.left' : 'member.removed',
          actor,
          target: { type: 'user', id: targetUserId, organizationId },
        });

        return { ok: true as const };
      }),
    { action: 'remove a member', context: { organizationId, targetUserId } },
  );

  if (!outcome.ok) {
    return json(
      {
        message: "You're the only admin. Make someone else an admin first.",
        code: 'last-admin',
      },
      { status: 409 },
    );
  }
  return new Response(null, { status: 204 });
}
