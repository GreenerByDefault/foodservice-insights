import type { DatabaseExecutor, OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** The layout already settled access; a member load only needs to know who is asking. */
export const load: PageServerLoad = async ({ locals, params }) => {
  const auth = requireAuth(locals);
  const organizationId = params.organizationId as OrganizationId;

  return {
    members: await withDbErrorHandling(
      () => _loadMembers(database(), { organizationId, viewerId: auth.user.id }),
      { action: 'load an organization’s members', context: { organizationId } },
    ),
  };
};

export type MemberRow = {
  displayName: string | null;
  email: string;
  role: OrganizationRole;
  /** Whether this row is the signed-in user's own membership. */
  isYou: boolean;
};

/** Every member of the organization, admins first then by email — a total, stable order.
 *
 * Superadmins are absent for free: they hold no `organization_member` row, so they never enter
 * this join regardless of the access `requireOrganizationAccess` grants them elsewhere.
 */
export async function _loadMembers(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; viewerId: UserId },
): Promise<MemberRow[]> {
  const rows = await db
    .selectFrom('organizationMember')
    .innerJoin('appUser', 'appUser.id', 'organizationMember.userId')
    .innerJoin('auth.users', 'auth.users.id', 'appUser.id')
    .select([
      'organizationMember.userId as userId',
      'appUser.displayName as displayName',
      'auth.users.email as email',
      'organizationMember.role as role',
    ])
    .where('organizationMember.organizationId', '=', params.organizationId)
    // `organization_role` is a Postgres enum declared `('member', 'admin')`, so a bare enum
    // comparison sorts by that declaration order, not alphabetically — `desc` is what puts
    // 'admin' first.
    .orderBy('organizationMember.role', 'desc')
    .orderBy('auth.users.email', 'asc')
    .execute();

  return rows.map((row) => ({
    displayName: row.displayName,
    // `auth.users.email` is nullable in the generated type but never actually null for a row
    // that made it into `app_user` — see `AuthenticatedUser.email`'s own comment.
    email: row.email as string,
    role: row.role,
    isYou: row.userId === params.viewerId,
  }));
}
