import type { DatabaseExecutor, OrganizationInviteId, OrganizationRole } from '@gbd/db';
import { sql } from 'kysely';
import { requireAuth } from '#lib/server/auth/guards.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const { user } = requireAuth(locals);
  return {
    invites: await withDbErrorHandling(() => _loadInvites(database(), user.email), {
      action: 'load the invites waiting for a user',
      context: { userId: user.id },
    }),
  };
};

export type InviteOffer = {
  inviteId: OrganizationInviteId;
  organizationName: string;
  role: OrganizationRole;
  /** Null when the inviter has no display name, or has since been deleted — the page then says
   * "An admin", as the invite email does. */
  invitedByName: string | null;
  expiresAt: Date;
  isExpired: boolean;
  /** The database's clock at read time — see `InviteRow.now` on the members page. */
  now: Date;
};

/** Every pending invite addressed to `email`, newest first. One past its deadline is still listed,
 * marked expired, so the invitee sees it once and dismisses it: a load never writes `expired`. */
export async function _loadInvites(db: DatabaseExecutor, email: string): Promise<InviteOffer[]> {
  return await db
    .selectFrom('organizationInvite')
    .innerJoin('organization', 'organization.id', 'organizationInvite.organizationId')
    .leftJoin('appUser', 'appUser.id', 'organizationInvite.invitedByUserId')
    .select([
      'organizationInvite.id as inviteId',
      'organization.name as organizationName',
      'organizationInvite.role as role',
      'appUser.displayName as invitedByName',
      'organizationInvite.expiresAt as expiresAt',
      sql<boolean>`organization_invite.expires_at <= now()`.as('isExpired'),
      sql<Date>`now()`.as('now'),
    ])
    // `email` is stored lowercased, which its own CHECK constraint guarantees; the session's
    // address isn't.
    .where('organizationInvite.email', '=', email.toLowerCase())
    .where('organizationInvite.status', '=', 'pending')
    // `id desc` breaks a `createdAt` tie, as `_loadPendingInvites` does and for the same reason.
    .orderBy('organizationInvite.createdAt', 'desc')
    .orderBy('organizationInvite.id', 'desc')
    .execute();
}
