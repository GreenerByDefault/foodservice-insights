import { type DatabaseExecutor, type OrganizationId, type UserId, withTransaction } from '@gbd/db';
import { error, json } from '@sveltejs/kit';
import { sql } from 'kysely';
import * as v from 'valibot';
import { recordAuditEvent } from '$lib/server/audit';
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

/** **Stub:** answers 501 until `memberships.md`'s remaining PR lands.
 *
 * Remove a member, or leave — the same request with your own id, which is why this is not two
 * endpoints. An admin may do either; a member may only do the second.
 *
 * `organization_member_at_least_one_admin` is deferred and takes a row lock, so it, not this
 * handler, decides whether the last admin may go. Turn its `check_violation` into a 409.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });

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
