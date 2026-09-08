import type { DatabaseExecutor } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { listOrganizations, type OrganizationRow } from '$lib/server/orgs/list';
import type { LayoutServerLoad } from './$types';
import { SWITCHER_LIMIT } from './shell/switcher-limit';

export type SwitcherOrganization = OrganizationRow;

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * `requireAuth` throws a 401 rather than becoming a redirect to `/sign-in`: `$lib/components/
 * error-page.svelte` renders a message today, and will offer sign-in in place once auth lands, so
 * the page the user actually asked for renders as soon as `invalidateAll()` re-runs this load.
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

/** The organizations the switcher offers this user, capped at `SWITCHER_LIMIT`. */
export async function _loadSwitcherOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<{ organizations: readonly SwitcherOrganization[]; hasMoreOrganizations: boolean }> {
  const rows = await listOrganizations(db, auth, { limit: SWITCHER_LIMIT + 1 });

  return {
    organizations: rows.slice(0, SWITCHER_LIMIT),
    hasMoreOrganizations: rows.length > SWITCHER_LIMIT,
  };
}
