/** Where a signed-in user goes when they have not asked for anything in particular. */

import type { DatabaseExecutor } from '@gbd/db';
import { redirect } from '@sveltejs/kit';
import { sql } from 'kysely';
import { organizationHref } from '$lib/hrefs';
import { requireAuth } from '$lib/server/auth/guards';
import type { AuthContext } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const destination = await _resolvePostSignInDestination(database(), requireAuth(locals));
  if (destination) redirect(303, destination);
};

/** The next page, or null to stay here and pick one. */
export async function _resolvePostSignInDestination(
  db: DatabaseExecutor,
  auth: AuthContext,
): Promise<string | null> {
  if (await hasLiveInvite(db, auth)) return '/invites';

  // A superadmin's memberships don't bound what they may act in — see `AuthContext` — so the
  // membership count below would send one with none straight to `/orgs/new`, offering a create
  // form metered at five to the one user who should see every organization instead.
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
