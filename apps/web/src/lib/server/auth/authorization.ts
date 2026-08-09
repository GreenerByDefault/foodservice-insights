/** What a user ID is allowed to do. */

import type { DatabaseExecutor, OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import type { AuthContext, Membership } from './types.ts';

/** The user and every organization they belong to, or null if there is no such user. */
export async function loadAuthorization(
  db: DatabaseExecutor,
  userId: UserId,
): Promise<AuthContext | null> {
  // Two reads rather than one join, because a user with no memberships still has an identity,
  // and a left join would make every caller sort that out from nullable columns. Both are
  // indexed: this one on `app_user`'s primary key, the membership query below on
  // `organization_member`'s, whose leading column is `user_id`.
  const user = await db
    .selectFrom('appUser')
    .innerJoin('auth.users', 'auth.users.id', 'appUser.id')
    .select(['appUser.id', 'appUser.displayName', 'appUser.isSuperadmin', 'auth.users.email'])
    .where('appUser.id', '=', userId)
    .executeTakeFirst();

  if (!user) return null;

  // `auth.users.email` is nullable because Supabase supports providers that do not require one.
  // Ours is email OTP, and REQUIREMENTS.md rejects social sign-on and passkeys, so every user we
  // will ever have has an email. Narrowed once, here, rather than pushed onto every consumer.
  if (!user.email) {
    throw new Error(
      `The user ${userId} has no email, which email-OTP auth should make impossible.`,
    );
  }

  const memberships = await db
    .selectFrom('organizationMember')
    .innerJoin('organization', 'organization.id', 'organizationMember.organizationId')
    .select([
      'organization.id as organizationId',
      'organization.name as organizationName',
      'organizationMember.role as role',
    ])
    .where('organizationMember.userId', '=', userId)
    // By name, not by when they joined, so the organization switcher has a stable order.
    .orderBy('organization.name')
    .execute();

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isSuperadmin: user.isSuperadmin,
    },
    memberships,
  };
}

/** What `auth` may do in `organizationId`, or null if it may do nothing there. */
export function effectiveRole(
  auth: AuthContext,
  organizationId: OrganizationId,
): OrganizationRole | null {
  if (auth.user.isSuperadmin) return 'admin';
  return findMembership(auth, organizationId)?.role ?? null;
}

export function findMembership(
  auth: AuthContext,
  organizationId: OrganizationId,
): Membership | undefined {
  return auth.memberships.find((membership) => membership.organizationId === organizationId);
}
