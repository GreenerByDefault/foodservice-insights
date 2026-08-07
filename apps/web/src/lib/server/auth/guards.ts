/** The checks a route makes before doing anything.
 *
 * All pure: they read an `AuthContext` the hook already loaded, so a guard never costs a query and
 * is testable without a database.
 */

import type { OrganizationId, OrganizationRole } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { effectiveRole } from './authorization.ts';
import type { AuthContext } from './types.ts';

/** The signed-in user, or a 401.
 *
 * Phase one cannot be signed out, so this only fires if the database is unreachable. Once there is
 * a sign-in page, pages should redirect there instead; API routes keep the 401.
 */
export function requireAuth(locals: App.Locals): AuthContext {
  if (!locals.auth) error(401, { message: 'Not signed in', code: 'unauthenticated' });
  return locals.auth;
}

/** The user's role in `organizationId`, or a 404.
 *
 * 404 rather than 403, everywhere: whether an organization exists and whether you belong to it must
 * be indistinguishable, or the error code itself leaks the customer list.
 */
export function requireMembership(
  auth: AuthContext,
  organizationId: OrganizationId,
): OrganizationRole {
  const role = effectiveRole(auth, organizationId);
  if (!role) error(404, { message: 'Not found', code: 'not_found' });
  return role;
}

/** Like `requireMembership`, but 403s a member who is not an admin.
 *
 * 403 is safe here where it is not in `requireMembership`: reaching this point already proves
 * membership, so the status reveals nothing the caller did not know.
 */
export function requireOrganizationAdmin(auth: AuthContext, organizationId: OrganizationId): void {
  if (requireMembership(auth, organizationId) !== 'admin') {
    error(403, { message: 'Only an admin can do that', code: 'forbidden' });
  }
}
