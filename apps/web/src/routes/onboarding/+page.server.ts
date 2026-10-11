import { redirect } from '@sveltejs/kit';
import { requireAuth } from '#lib/server/auth/guards.js';
import type { PageServerLoad } from './$types';

/** Outside `(app)`, whose gate is what sends a user here. Signed out is the same 401 as there, so
 * signing in on it re-runs this load. */
export const load: PageServerLoad = ({ locals }) => {
  // Answered already, so `/orgs` works out where they belong. That is also what keeps Back from
  // returning here after saving.
  if (requireAuth(locals).user.displayName !== null) redirect(303, '/orgs');
};
