/** What a user ID is allowed to do. */

import type { DatabaseExecutor, OrganizationId, UserId } from '@gbd/db';
import type { AuthContext, OrganizationAccess } from './types.ts';

/** The user and every organization they may act in, or null if there is no such user. */
export async function loadAuthorization(
  db: DatabaseExecutor,
  userId: UserId,
): Promise<AuthContext | null> {
  // Two reads rather than one join, because a user with no organizations still has an identity,
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

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isSuperadmin: user.isSuperadmin,
    },
    organizations: user.isSuperadmin
      ? await everyOrganization(db)
      : await memberOrganizations(db, userId),
  };
}

async function memberOrganizations(
  db: DatabaseExecutor,
  userId: UserId,
): Promise<OrganizationAccess[]> {
  return await db
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
}

/** Admin access to every organization, which is what being a superadmin means.
 *
 * Materialized here so that no check further down has to know superadmins exist: `admin` on a row
 * that is present behaves the same however it got there, and an id nobody has simply is not in the
 * list. The cost is a scan of `organization` on each request a superadmin makes — bounded by the
 * customer count, paid by nobody else.
 */
async function everyOrganization(db: DatabaseExecutor): Promise<OrganizationAccess[]> {
  const organizations = await db
    .selectFrom('organization')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();

  return organizations.map(({ id, name }) => ({
    organizationId: id,
    organizationName: name,
    role: 'admin',
  }));
}

export function findOrganizationAccess(
  auth: AuthContext,
  organizationId: OrganizationId,
): OrganizationAccess | undefined {
  return auth.organizations.find((access) => access.organizationId === organizationId);
}
