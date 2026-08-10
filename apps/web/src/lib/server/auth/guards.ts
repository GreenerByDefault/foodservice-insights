/** The checks a route makes before doing anything. */

import type { OrganizationId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { findOrganizationAccess } from './authorization.ts';
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
 */
export function requireOrganizationAccess(
  auth: AuthContext,
  organizationId: OrganizationId,
): OrganizationAccess {
  const access = findOrganizationAccess(auth, organizationId);
  if (!access) error(404, { message: 'Not found', code: 'not_found' });
  return access;
}

/** Like `requireOrganizationAccess`, but 403s someone who is not an admin.
 *
 * 403 is safe here because reaching this point already proves access, so the
 * status reveals nothing the caller did not know.
 */
export function requireOrganizationAdmin(auth: AuthContext, organizationId: OrganizationId): void {
  if (requireOrganizationAccess(auth, organizationId).role !== 'admin') {
    error(403, { message: 'Only an admin can do that', code: 'forbidden' });
  }
}
