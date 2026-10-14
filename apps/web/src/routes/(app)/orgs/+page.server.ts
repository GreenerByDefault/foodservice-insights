/** The `/orgs` picker: redirects on to an invite, a single organization, or the new-organization
 * flow before falling back to the full list — which, for a superadmin, is every organization in
 * the table, not just ones they belong to. */

import type { DatabaseExecutor } from '@gbd/db';
import { redirect } from '@sveltejs/kit';
import { sql } from 'kysely';
import { organizationHref } from '#lib/hrefs.js';
import { requireAuth } from '#lib/server/auth/guards.js';
import type { AuthContext } from '#lib/server/auth/types.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import { listOrganizations, type OrganizationRow } from '#lib/server/orgs/list.js';
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
  const invite = await waitingInvite(db, auth);
  if (invite === 'live') return '/invites';

  // Even if a superadmin doesn't belong as a normal member to any organizations,
  // they should see the full organization list rather than the org creation list.
  if (auth.user.isSuperadmin) return null;

  // Somebody who belongs nowhere most likely signed up through the invite, so they are told it
  // ran out rather than offered a new organization as if they had never been invited. A member
  // is not: they have somewhere to go, and `/invites` is in the user menu.
  if (auth.memberships.length === 0) return invite === 'expired' ? '/invites' : '/orgs/new';

  const singleOrg = auth.memberships.length === 1 ? auth.memberships[0] : undefined;
  return singleOrg ? organizationHref(singleOrg.organizationSlug) : null;
}

/** Whether an undismissed invite is waiting, and if so whether any has not run out. */
async function waitingInvite(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<'live' | 'expired' | 'none'> {
  const invite = await withDbErrorHandling(
    () =>
      db
        .selectFrom('organizationInvite')
        // Reads `expires_at` rather than trusting `status`, because nothing writes `expired`
        // when the deadline passes — only dismissing it on `/invites` does.
        // Compares against the database's clock, not the server's.
        .select(sql<boolean>`expires_at <= now()`.as('isExpired'))
        // `email` is stored lowercased, which its own CHECK constraint guarantees.
        .where('email', '=', auth.user.email.toLowerCase())
        .where('status', '=', 'pending')
        // The latest deadline decides: if it has passed, every one has.
        .orderBy('expiresAt', 'desc')
        .limit(1)
        .executeTakeFirst(),
    { action: 'look for a pending invite', context: { userId: auth.user.id } },
  );

  if (invite === undefined) return 'none';
  return invite.isExpired ? 'expired' : 'live';
}
