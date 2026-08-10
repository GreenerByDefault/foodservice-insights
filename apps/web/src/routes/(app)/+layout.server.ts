import { requireAuth } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * Children can run `const { auth } = await parent()` to load the user. `auth.organizations` is
 * already the switcher's list, so this costs no query — `handle` has done the work.
 *
 * The 401 `requireAuth` throws stays a 401 rather than becoming a redirect to `/sign-in`:
 * `$lib/components/error-page.svelte` offers sign-in in place, so the page the user actually asked
 * for renders as soon as `invalidateAll()` re-runs this load.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: requireAuth(locals) });
