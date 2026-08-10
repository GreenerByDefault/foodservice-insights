/** Which organization a request acts on, and which ones the switcher may offer. */

import type { DatabaseExecutor, OrganizationId, OrganizationRole } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { findMembership } from './auth/authorization.ts';
import { requireMembership } from './auth/guards.ts';
import type { AuthContext } from './auth/types.ts';
import { withDbErrorHandling } from './db.ts';

export type OrganizationSummary = {
  id: OrganizationId;
  name: string;
};

export type OrganizationContext = {
  organization: OrganizationSummary;
  role: OrganizationRole;
};

/** The organization `organizationId` names, and what `auth` may do in it.
 *
 * A member costs no query: their membership row carries the name already, and its foreign key is
 * proof the organization exists.
 */
export async function resolveOrganization(
  db: DatabaseExecutor,
  auth: AuthContext,
  organizationId: OrganizationId,
): Promise<OrganizationContext> {
  const role = requireMembership(auth, organizationId);

  const membership = findMembership(auth, organizationId);
  if (membership) {
    return { organization: { id: organizationId, name: membership.organizationName }, role };
  }

  // Only a superadmin reaches here, since `requireMembership` answers `admin` for them against any
  // id at all — which is why this read is not just for the name. Without it an invented id would
  // render them an organization that does not exist.
  const organization = await withDbErrorHandling(
    () =>
      db
        .selectFrom('organization')
        .select(['id', 'name'])
        .where('id', '=', organizationId)
        .executeTakeFirst(),
    { action: 'load an organization', context: { organizationId } },
  );

  // 404, matching `requireMembership`, so "no such organization" and "not yours" stay
  // indistinguishable.
  if (!organization) error(404, { message: 'Not found', code: 'not_found' });

  return { organization, role };
}

/** Every organization the user may switch to, ordered by name.
 *
 * A superadmin sees all of them, so they need a read; nobody else does. Deliberately not part of
 * `loadAuthorization`, which runs in `handle` on every single request and must not scan a table.
 */
export async function switchableOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<readonly OrganizationSummary[]> {
  if (!auth.user.isSuperadmin) {
    return auth.memberships.map(({ organizationId, organizationName }) => ({
      id: organizationId,
      name: organizationName,
    }));
  }

  return await withDbErrorHandling(
    () => db.selectFrom('organization').select(['id', 'name']).orderBy('name').execute(),
    {
      action: 'list the organizations a superadmin can switch to',
      context: { userId: auth.user.id },
    },
  );
}
