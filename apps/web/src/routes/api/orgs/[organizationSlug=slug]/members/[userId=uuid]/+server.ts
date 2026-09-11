import type { DatabaseExecutor, OrganizationId, UserId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import * as v from 'valibot';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import { requireMemberRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { parseBody } from '$lib/server/body';
import { database, withDbErrorHandling } from '$lib/server/db';
import { attemptMemberWrite, lastAdminResponse } from '$lib/server/orgs/members';
import type { RequestHandler } from './$types';

const ChangeRoleBodySchema = v.object({ role: v.picklist(['admin', 'member']) });

/** Promote or demote. Admin only. */
export const PATCH: RequestHandler = async (event) => {
  const { organizationId, actor, targetUserId } = await requireMemberRouteContext(
    database(),
    event,
    { admin: true },
  );
  const body = await event.request.json();

  return await _changeMemberRole(database(), { organizationId, actor, targetUserId }, body);
};

/** Remove a member, or leave — the same request with your own id, which is why this is not two
 * endpoints. An admin may do either; a member may only do the second, so a request for anyone
 * else's id requires admin, resolved as part of the one access check below rather than a second.
 */
export const DELETE: RequestHandler = async (event) => {
  const { organizationId, actor, targetUserId } = await requireMemberRouteContext(
    database(),
    event,
    { admin: event.params.userId !== requireAuth(event.locals).user.id },
  );

  return await _removeMember(database(), { organizationId, actor, targetUserId });
};

/** Promote or demote `targetUserId` to `role`, from `body`'s `{ role }`.
 *
 * - 400 for a body that isn't `{ role: 'admin' | 'member' }`.
 * - 404 if `targetUserId` isn't a member of `organizationId` — `App.Error`'s `code` already
 *   carries `'not_found'`, so this goes through `error()` like every other route's 404.
 * - 204 with no audit row if the role is already `role` — a no-op is not a role change.
 * - 409 `last-admin` if this would leave the organization with no admin — see
 *   `attemptMemberWrite`'s header comment for why. `last-admin` is this route's own code, not
 *   `App.Error`'s, so this is a `json()` response built after the transaction settles, the same
 *   way `nameTakenResponse` answers a collision — not a caught-and-rethrown `error()`.
 */
export async function _changeMemberRole(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; actor: Actor; targetUserId: UserId },
  body: unknown,
): Promise<Response> {
  const { organizationId, actor, targetUserId } = params;

  const parsedBody = parseBody(ChangeRoleBodySchema, body);
  if (!parsedBody.ok) return parsedBody.response;
  const { role } = parsedBody.value;

  const outcome = await withDbErrorHandling(
    () =>
      attemptMemberWrite(db, async (transaction) => {
        // The only row lock in apps/web: it makes the "same role → 204, no audit row" decision
        // and the audit `detail` (which needs the *previous* role) consistent under two
        // concurrent role changes to the same row.
        const member = await transaction
          .selectFrom('organizationMember')
          .select('role')
          .where('organizationId', '=', organizationId)
          .where('userId', '=', targetUserId)
          .forUpdate()
          .executeTakeFirst();

        if (!member) error(404, { message: 'Not found', code: 'not_found' });
        if (member.role === role) return;

        await transaction
          .updateTable('organizationMember')
          .set({ role })
          .where('organizationId', '=', organizationId)
          .where('userId', '=', targetUserId)
          .execute();

        await recordAuditEvent(transaction, {
          action: 'member.role_changed',
          actor,
          target: { type: 'user', id: targetUserId, organizationId },
          detail: { from: member.role, to: role },
        });
      }),
    { action: "change a member's role", context: { organizationId, targetUserId } },
  );

  if (outcome === 'last-admin') return lastAdminResponse();
  return new Response(null, { status: 204 });
}

/** Remove `targetUserId` from `organizationId` — or leave, when it's `actor`'s own id.
 *
 * - 404 if `targetUserId` isn't a member of `organizationId`.
 * - 409 `last-admin` if this would leave the organization with no admin — see
 *   `attemptMemberWrite`'s header comment for why. No row lock is needed here, unlike
 *   `_changeMemberRole`: `DELETE … RETURNING` is a single statement, so there's nothing to hold
 *   consistent across a read and a later write.
 * - Otherwise `member.left` when `targetUserId` is `actor` else `member.removed`, then 204.
 */
export async function _removeMember(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; actor: Actor; targetUserId: UserId },
): Promise<Response> {
  const { organizationId, actor, targetUserId } = params;

  const outcome = await withDbErrorHandling(
    () =>
      attemptMemberWrite(db, async (transaction) => {
        const removed = await transaction
          .deleteFrom('organizationMember')
          .where('organizationId', '=', organizationId)
          .where('userId', '=', targetUserId)
          .returning('userId')
          .executeTakeFirst();

        if (!removed) error(404, { message: 'Not found', code: 'not_found' });

        await recordAuditEvent(transaction, {
          action: targetUserId === actor.userId ? 'member.left' : 'member.removed',
          actor,
          target: { type: 'user', id: targetUserId, organizationId },
        });
      }),
    { action: 'remove a member', context: { organizationId, targetUserId } },
  );

  if (outcome === 'last-admin') return lastAdminResponse();
  return new Response(null, { status: 204 });
}
