import type { DatabaseExecutor, OrganizationInviteId, UserId } from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { json } from '@sveltejs/kit';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { lockInviteFor } from '$lib/server/invites/claim';
import type { RequestHandler } from './$types';

/** Decline an invite. Same guard as accepting, separate audit action. */
export const POST: RequestHandler = async (event) => {
  const { user } = requireAuth(event.locals);
  const inviteId = event.params.inviteId as OrganizationInviteId;

  return await _declineInvite(database(), { inviteId, user });
};

type DeclineInviteOutcome =
  | { kind: 'declined' }
  | { kind: 'expired' }
  | { kind: 'no-longer-valid' };

/** Decline `inviteId` on behalf of `user` — 404 if it isn't a pending-or-expired invite for
 * `user.email` (`lockInviteFor`'s guard).
 *
 * - Not `pending` → 409 `no-longer-valid`, nothing written.
 * - Past `expires_at` → write `expired`, audit `invite.expired` → 204. This is the "one-time
 *   notice": nothing else writes `expired`, and a load never does.
 * - Otherwise write `declined`, audit `invite.declined` → 204.
 */
export async function _declineInvite(
  db: DatabaseExecutor,
  params: { inviteId: OrganizationInviteId; user: { id: UserId; email: string } },
): Promise<Response> {
  const { inviteId, user } = params;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction): Promise<DeclineInviteOutcome> => {
        const invite = await lockInviteFor(transaction, inviteId, user.email);
        if (invite.status !== 'pending') return { kind: 'no-longer-valid' };

        const status = invite.isExpired ? 'expired' : 'declined';

        await transaction
          .updateTable('organizationInvite')
          .set({ status })
          .where('id', '=', invite.id)
          .execute();

        await recordAuditEvent(transaction, {
          action: status === 'expired' ? 'invite.expired' : 'invite.declined',
          actor: { userId: user.id },
          target: { type: 'invite', id: invite.id, organizationId: invite.organizationId },
        });

        return { kind: status };
      }),
    { action: 'decline an invite', context: { inviteId } },
  );

  if (outcome.kind === 'no-longer-valid') {
    return json(
      { message: 'This invitation is no longer valid.', code: 'no-longer-valid' },
      { status: 409 },
    );
  }
  return new Response(null, { status: 204 });
}
