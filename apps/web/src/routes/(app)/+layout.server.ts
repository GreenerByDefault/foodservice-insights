import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';
import { SWITCHER_LIMIT } from './switcher-limit';

export type SwitcherOrganization = { id: OrganizationId; name: string };

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * `requireAuth` throws a 401 rather than becoming a redirect to `/sign-in`:
 * `$lib/components/error-page.svelte` offers sign-in in place, so the page the user actually asked
 * for renders as soon as `invalidateAll()` re-runs this load.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const auth = requireAuth(locals);
  const { organizations, hasMoreOrganizations } = await _loadSwitcherOrganizations(
    database(),
    auth,
  );
  return {
    user: { email: auth.user.email, displayName: auth.user.displayName },
    organizations,
    hasMoreOrganizations,
  };
};

/** The organizations the switcher offers this user, capped at `SWITCHER_LIMIT`.
 *
 * A superadmin sees the whole `organization` table, alphabetically. It's a bounded query, unlike
 * `orgs/+page.server.ts`'s `_loadAllOrganizations`, which reads the same table unbounded for the
 * full `/orgs` picker. Meanwhile, non-superadmins already hold their full membership list in
 * `auth.memberships`, ordered by name (see `memberOrganizations`), so they don't need the
 * database.
 */
export async function _loadSwitcherOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<{ organizations: readonly SwitcherOrganization[]; hasMoreOrganizations: boolean }> {
  const rows: readonly SwitcherOrganization[] = auth.user.isSuperadmin
    ? await withDbErrorHandling(
        () =>
          db
            .selectFrom('organization')
            .select(['id', 'name'])
            .orderBy('name')
            .limit(SWITCHER_LIMIT + 1)
            .execute(),
        { action: 'list organizations for the switcher', context: { userId: auth.user.id } },
      )
    : auth.memberships.slice(0, SWITCHER_LIMIT + 1).map((membership) => ({
        id: membership.organizationId,
        name: membership.organizationName,
      }));

  return {
    organizations: rows.slice(0, SWITCHER_LIMIT),
    hasMoreOrganizations: rows.length > SWITCHER_LIMIT,
  };
}
