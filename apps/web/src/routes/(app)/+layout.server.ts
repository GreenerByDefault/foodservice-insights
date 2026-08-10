import { requireAuth } from '$lib/server/auth/guards';
import { database } from '$lib/server/db';
import { switchableOrganizations } from '$lib/server/organizations';
import type { LayoutServerLoad } from './$types';

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * Children can run `const { auth } = await parent()` to load the user.
 *
 * Keep this load function fast to avoid slowing down children. The switcher's list is free for a
 * member — their memberships already carry it — and costs a superadmin one read.
 *
 * The 401 `requireAuth` throws stays a 401 rather than becoming a redirect to `/sign-in`:
 * `$lib/components/error-page.svelte` offers sign-in in place, so the page the user actually asked
 * for renders as soon as `invalidateAll()` re-runs this load.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  const auth = requireAuth(locals);

  return { auth, switchableOrganizations: await switchableOrganizations(database(), auth) };
};
