import type { DatabaseExecutor, OrganizationInviteId, UserId } from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { json } from '@sveltejs/kit';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { lockInviteForEmailOrNotFound } from '$lib/server/invites/claim';
import type { RequestHandler } from './$types';

/** Accept an invite, joining the organization with the role it names.
 *
 * Not under `/api/orgs/[organizationId]` like the rest, deliberately: the caller is not a member
 * yet, so an organization-scoped path would promise a guard that could never pass. The guard here is
 * that the invite's email matches the caller's verified one — which is what makes forwarding the
 * email useless.
 *
 * Refuse an invite already past `expires_at`, and write the `expired` status while refusing it.
 */
export const POST: RequestHandler = async (event) => {
  const { user } = requireAuth(event.locals);
  const inviteId = event.params.inviteId as OrganizationInviteId;

  return await _acceptInvite(database(), { inviteId, user });
};

type AcceptInviteOutcome =
  | { kind: 'accepted'; organizationSlug: string }
  | { kind: 'expired' }
  | { kind: 'no-longer-valid' };

/** Accept `inviteId` on behalf of `user` — 404 if it isn't a pending-or-expired invite for
 * `user.email`.
 *
 * - Status not `pending` (already accepted, declined, revoked, or superseded) → 409
 *   `no-longer-valid`.
 * - Past `expires_at` → write `expired`, audit `invite.expired` → 410 `expired`.
 * - Otherwise insert the membership (a no-op if `user` already has one), mark `accepted`,
 *   audit `invite.accepted` → 200 `{ organizationSlug }`.
 */
export async function _acceptInvite(
  db: DatabaseExecutor,
  params: { inviteId: OrganizationInviteId; user: { id: UserId; email: string } },
): Promise<Response> {
  const { inviteId, user } = params;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction): Promise<AcceptInviteOutcome> => {
        const invite = await lockInviteForEmailOrNotFound(transaction, inviteId, user.email);
        if (invite.status !== 'pending') return { kind: 'no-longer-valid' };

        if (invite.isExpired) {
          await transaction
            .updateTable('organizationInvite')
            .set({ status: 'expired' })
            .where('id', '=', invite.id)
            .execute();

          await recordAuditEvent(transaction, {
            action: 'invite.expired',
            actor: { userId: user.id },
            target: { type: 'invite', id: invite.id, organizationId: invite.organizationId },
          });

          return { kind: 'expired' };
        }

        // `onConflict().doNothing()`, not a caught unique violation: a statement error would
        // abort the whole transaction (`withTransaction`'s doc comment), and the audit row and
        // status update below still need to run in this one.
        await transaction
          .insertInto('organizationMember')
          .values({ organizationId: invite.organizationId, userId: user.id, role: invite.role })
          .onConflict((oc) => oc.columns(['userId', 'organizationId']).doNothing())
          .execute();

        await transaction
          .updateTable('organizationInvite')
          .set({ status: 'accepted' })
          .where('id', '=', invite.id)
          .execute();

        await recordAuditEvent(transaction, {
          action: 'invite.accepted',
          actor: { userId: user.id },
          target: { type: 'invite', id: invite.id, organizationId: invite.organizationId },
        });

        const organization = await transaction
          .selectFrom('organization')
          .select('slug')
          .where('id', '=', invite.organizationId)
          .executeTakeFirstOrThrow();

        return { kind: 'accepted', organizationSlug: organization.slug };
      }),
    { action: 'accept an invite', context: { inviteId } },
  );

  if (outcome.kind === 'no-longer-valid') {
    return json(
      { message: 'This invitation is no longer valid.', code: 'no-longer-valid' },
      { status: 409 },
    );
  }
  if (outcome.kind === 'expired') {
    return json({ message: 'This invitation has expired.', code: 'expired' }, { status: 410 });
  }
  return json({ organizationSlug: outcome.organizationSlug }, { status: 200 });
}
