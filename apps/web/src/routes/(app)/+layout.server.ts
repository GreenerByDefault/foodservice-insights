import type { DatabaseExecutor } from '@gbd/db';
import { requireOnboarded } from '#lib/server/auth/guards.js';
import type { AuthContext } from '#lib/server/auth/types.js';
import { database } from '#lib/server/db.js';
import { listOrganizations, type OrganizationRow } from '#lib/server/orgs/list.js';
import type { LayoutServerLoad } from './$types';
import { SWITCHER_LIMIT } from './shell/switcher-limit.ts';

export type SwitcherOrganization = OrganizationRow;

/** The gate for everything inside `(app)`: a request gets no further without an identity, nor
 * without the display name onboarding asks for.
 *
 * Both are errors rather than redirects: `#lib/components/error-page.svelte` signs the user in, or
 * asks their name, in place, so the page they actually asked for renders as soon as `refreshAll()`
 * re-runs this load.
 *
 * A page's own redirect still goes through on a client-side navigation, since any load's redirect
 * replaces the whole `__data.json` response. So `/orgs` forwards a nameless invitee to `/invites`,
 * and this gate asks their name there. Each page load calls `requireAuth` itself, so what loads
 * beside the gate's error is never more than the user may see.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const auth = requireOnboarded(locals);
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
