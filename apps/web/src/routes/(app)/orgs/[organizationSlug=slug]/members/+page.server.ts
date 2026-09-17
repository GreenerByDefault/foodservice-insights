import type {
  DatabaseExecutor,
  OrganizationId,
  OrganizationInviteId,
  OrganizationRole,
  UserId,
} from '@gbd/db';
import { sql } from 'kysely';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';
import { MEMBERS_DEPENDENCY } from './dependencies.ts';

/** The layout already settled access; a member load only needs to know who is asking, and the
 * organization id the layout already resolved from the URL's slug. Only an admin sees pending
 * invites — a member gets `null` rather than an empty list, so the page can tell "there are none"
 * from "you may not see them" without re-deriving the role. */
export const load: PageServerLoad = async ({ locals, parent, depends }) => {
  const auth = requireAuth(locals);
  const { organization, role } = await parent();
  depends(MEMBERS_DEPENDENCY);

  return {
    members: await withDbErrorHandling(
      () => _loadMembers(database(), { organizationId: organization.id, viewerId: auth.user.id }),
      { action: "load an organization's members", context: { organizationId: organization.id } },
    ),
    invites:
      role === 'admin'
        ? await withDbErrorHandling(
            () => _loadPendingInvites(database(), { organizationId: organization.id }),
            {
              action: "load an organization's pending invites",
              context: { organizationId: organization.id },
            },
          )
        : null,
  };
};

export type MemberRow = {
  userId: UserId;
  displayName: string | null;
  email: string;
  role: OrganizationRole;
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
    userId: row.userId,
    displayName: row.displayName,
    // `auth.users.email` is nullable in the generated type but never actually null for a row
    // that made it into `app_user` — see `AuthenticatedUser.email`'s own comment.
    email: row.email as string,
    role: row.role,
    isYou: row.userId === params.viewerId,
  }));
}

export type InviteRow = {
  inviteId: OrganizationInviteId;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  isExpired: boolean;
  /** The database's clock at read time, for `RelativeTime` to compute "Expires in …" against —
   * the same reason `ReportListRow.now` exists, and why this is a per-row snapshot rather than a
   * `new Date()` taken here: a JS-clock comparison can land on the wrong side of `expiresAt`. */
  now: Date;
};

/** Every pending invite, newest first — superseded and revoked rows are never shown, and a
 * "pending" row past its deadline still shows here as expired rather than disappearing, so the
 * admin knows to re-invite. Nothing writes `expired` on a load; only an invitee acting on an
 * expired invite does. */
export async function _loadPendingInvites(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId },
): Promise<InviteRow[]> {
  const rows = await db
    .selectFrom('organizationInvite')
    .select([
      'id as inviteId',
      'email',
      'role',
      'expiresAt',
      sql<boolean>`expires_at <= now()`.as('isExpired'),
      sql<Date>`now()`.as('now'),
    ])
    .where('organizationId', '=', params.organizationId)
    .where('status', '=', 'pending')
    // `id desc` breaks a tie on `createdAt`: `now()` is fixed for a whole transaction, so two
    // invites created in the same one — as a fixture, or two rapid re-invites — share one
    // timestamp. `id` is a UUIDv7, so this still lands newest-first.
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows;
}
