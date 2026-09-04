/** A list of all organizations the user belongs to, in alphabetical order. */

import type { DatabaseExecutor } from '@gbd/db';
import { redirect } from '@sveltejs/kit';
import { sql } from 'kysely';
import { organizationHref } from '$lib/hrefs';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const auth = requireAuth(locals);
  const destination = await _resolvePostSignInDestination(database(), auth);
  if (destination) redirect(303, destination);
  return { organizations: await _loadAllOrganizations(database(), auth) };
};

/** Every organization this user may pick, name-ordered, with no cap. */
export async function _loadAllOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<readonly { id: string; name: string }[]> {
  if (!auth.user.isSuperadmin) {
    return auth.memberships.map((membership) => ({
      id: membership.organizationId,
      name: membership.organizationName,
    }));
  }

  return await withDbErrorHandling(
    () => db.selectFrom('organization').select(['id', 'name']).orderBy('name').execute(),
    { action: 'list all organizations', context: { userId: auth.user.id } },
  );
}

/** The next page, or null to stay here and pick one. */
export async function _resolvePostSignInDestination(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<string | null> {
  if (await hasLiveInvite(db, auth)) return '/invites';

  // Even if a superadmin doesn't belong as a normal member to any organizations,
  // they should see the full organization list rather than the org creation list.
  if (auth.user.isSuperadmin) return null;

  if (auth.memberships.length === 0) return '/orgs/new';

  const singleOrg = auth.memberships.length === 1 ? auth.memberships[0] : undefined;
  return singleOrg ? organizationHref(singleOrg.organizationId) : null;
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
