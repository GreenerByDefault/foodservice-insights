import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/** How many organizations the switcher lists before handing off to `/orgs`. Also the over-fetch
 * cutoff below: asking for one row past this tells the loader whether to show "View all
 * organizations" with no separate `count(*)`. */
export const _SWITCHER_LIMIT = 8;

export type SwitcherOrganization = { id: OrganizationId; name: string };

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * `requireAuth` throws a 401 rather than becoming a redirect to `/sign-in`:
 * `$lib/components/error-page.svelte` offers sign-in in place, so the page the user actually asked
 * for renders as soon as `invalidateAll()` re-runs this load.
 *
 * Returns only what the shell renders, not the whole `AuthContext` — `organizations` is what the
 * header's switcher offers, already capped; nothing downstream needs the rest of `auth`.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const auth = requireAuth(locals);
  const { organizations, hasMoreOrganizations } = await _loadSwitcherOrganizations(
    database(),
    auth,
  );
  return { user: { email: auth.user.email }, organizations, hasMoreOrganizations };
};

/** The organizations the switcher offers this user, capped at `_SWITCHER_LIMIT`.
 *
 * A superadmin sees the whole `organization` table, alphabetically, in one bounded query — the
 * unbounded scan this replaced (see `requireOrganizationAccess`) is already fixed there; this is
 * the one remaining place that read every organization, now bounded by `LIMIT`. Everyone else is
 * already holding their full membership list in `auth.memberships`, ordered by name (see
 * `memberOrganizations`), so this reads no database at all.
 *
 * Truncated here, not only in the switcher component: `auth.memberships` isn't bounded by the
 * five-organization create limit — invites can put a user in far more — so leaving it unsliced
 * would report `hasMoreOrganizations` as false while quietly handing the component more rows than
 * it renders.
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
            .limit(_SWITCHER_LIMIT + 1)
            .execute(),
        { action: 'list organizations for the switcher', context: { userId: auth.user.id } },
      )
    : auth.memberships.slice(0, _SWITCHER_LIMIT + 1).map((membership) => ({
        id: membership.organizationId,
        name: membership.organizationName,
      }));

  return {
    organizations: rows.slice(0, _SWITCHER_LIMIT),
    hasMoreOrganizations: rows.length > _SWITCHER_LIMIT,
  };
}
