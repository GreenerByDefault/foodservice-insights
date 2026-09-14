import {
  type DatabaseExecutor,
  type OrganizationId,
  type OrganizationInviteId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { recordAuditEvent } from '$lib/server/audit';
import { requireInviteRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Revoke a pending invite. Admin only. */
export const DELETE: RequestHandler = async (event) => {
  const { organizationId, actor, inviteId } = await requireInviteRouteContext(database(), event, {
    admin: true,
  });

  return await _revokeInvite(database(), { organizationId, actor, inviteId });
};

/** Revoke `inviteId` — 404 if it isn't a pending invite for `organizationId`, otherwise
 * `invite.revoked` and 204. */
export async function _revokeInvite(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; actor: Actor; inviteId: OrganizationInviteId },
): Promise<Response> {
  const { organizationId, actor, inviteId } = params;

  await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        const revoked = await transaction
          .updateTable('organizationInvite')
          .set({ status: 'revoked' })
          .where('id', '=', inviteId)
          .where('organizationId', '=', organizationId)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();

        if (!revoked) error(404, { message: 'Not found', code: 'not_found' });

        await recordAuditEvent(transaction, {
          action: 'invite.revoked',
          actor,
          target: { type: 'invite', id: inviteId, organizationId },
        });
      }),
    { action: 'revoke an invite', context: { organizationId, inviteId } },
  );

  return new Response(null, { status: 204 });
}
