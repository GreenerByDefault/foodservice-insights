/** The checks a route makes before doing anything. */

import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { withDbErrorHandling } from '$lib/server/db';
import type { AuthContext, OrganizationAccess } from './types.ts';

/** The signed-in user, or a 401. */
export function requireAuth(locals: App.Locals): AuthContext {
  if (!locals.auth) error(401, { message: 'Not signed in', code: 'unauthenticated' });
  return locals.auth;
}

/** The user's access to `organizationId`, or a 404.
 *
 * 404 rather than 403, everywhere: whether an organization exists and whether you may act in it
 * must be indistinguishable, or the error code itself leaks the customer list. An id no
 * organization has takes the same path, since it can be in nobody's list.
 *
 * A superadmin is admin everywhere, including an organization where they hold a `member` row —
 * so the flag is checked before the membership, never after. That check is a single PK lookup,
 * and it only ever runs for a superadmin: everyone else resolves from `auth.memberships`, already
 * in memory, with no database access and no timing difference between "no access" and "no such
 * organization".
 */
export async function requireOrganizationAccess(
  db: DatabaseExecutor,
  auth: AuthContext,
  organizationId: OrganizationId,
): Promise<OrganizationAccess> {
  if (auth.user.isSuperadmin) {
    return await withDbErrorHandling(
      async () => {
        const organization = await db
          .selectFrom('organization')
          .select(['id', 'name'])
          .where('id', '=', organizationId)
          .executeTakeFirst();
        if (!organization) error(404, { message: 'Not found', code: 'not_found' });
        return { organizationId, organizationName: organization.name, role: 'admin' as const };
      },
      { action: 'look up an organization for a superadmin', context: { organizationId } },
    );
  }

  const access = auth.memberships.find(
    (membership) => membership.organizationId === organizationId,
  );
  if (!access) error(404, { message: 'Not found', code: 'not_found' });
  return access;
}

/** Like `requireOrganizationAccess`, but 403s someone who is not an admin.
 *
 * 403 is safe here because reaching this point already proves access, so the
 * status reveals nothing the caller did not know.
 */
export async function requireOrganizationAdmin(
  db: DatabaseExecutor,
  auth: AuthContext,
  organizationId: OrganizationId,
): Promise<void> {
  if ((await requireOrganizationAccess(db, auth, organizationId)).role !== 'admin') {
    error(403, { message: 'Only an admin can do that', code: 'forbidden' });
  }
}
