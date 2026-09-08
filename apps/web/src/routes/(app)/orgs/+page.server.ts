/** The `/orgs` picker: redirects on to an invite, a single organization, or the new-organization
 * flow before falling back to the full list — which, for a superadmin, is every organization in
 * the table, not just ones they belong to. */

import type { DatabaseExecutor } from '@gbd/db';
import { redirect } from '@sveltejs/kit';
import { sql } from 'kysely';
import { organizationHref } from '$lib/hrefs';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { listOrganizations, type OrganizationRow } from '$lib/server/orgs/list';
import type { PageServerLoad } from './$types';

export type OrganizationListRow = OrganizationRow;

export const load: PageServerLoad = async ({ locals }) => {
  const auth = requireAuth(locals);
  const destination = await _organizationsPageRedirect(database(), auth);
  if (destination) redirect(303, destination);
  return { organizations: await _loadAllOrganizations(database(), auth) };
};

/** Every organization this user may pick, name-ordered, with no cap. */
export async function _loadAllOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<readonly OrganizationListRow[]> {
  return await listOrganizations(db, auth);
}

/** The next page, or null to stay here and pick one. */
export async function _organizationsPageRedirect(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<string | null> {
  if (await hasLiveInvite(db, auth)) return '/invites';

  // Even if a superadmin doesn't belong as a normal member to any organizations,
  // they should see the full organization list rather than the org creation list.
  if (auth.user.isSuperadmin) return null;

  if (auth.memberships.length === 0) return '/orgs/new';

  const singleOrg = auth.memberships.length === 1 ? auth.memberships[0] : undefined;
  return singleOrg ? organizationHref(singleOrg.organizationSlug) : null;
}

/** Whether an invite is waiting that has not run out. */
async function hasLiveInvite(db: DatabaseExecutor, auth: AuthContext): Promise<boolean> {
  const invite = await withDbErrorHandling(
    () =>
      db
        .selectFrom('organizationInvite')
        .select('id')
        // `email` is stored lowercased, which its own CHECK constraint guarantees.
        .where('email', '=', auth.user.email.toLowerCase())
        // Reads `expires_at` rather than trusting `status`, because nothing writes `expired`
        // when the deadline passes.
        .where('status', '=', 'pending')
        // Compares against the database's clock, not the server's.
        .where('expiresAt', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    { action: 'look for a pending invite', context: { userId: auth.user.id } },
  );

  return invite !== undefined;
}
