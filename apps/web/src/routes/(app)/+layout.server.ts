import { requireAuth } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * `requireAuth` throws a 401 rather than becoming a redirect to `/sign-in`:
 * `$lib/components/error-page.svelte` offers sign-in in place, so the page the user actually asked
 * for renders as soon as `invalidateAll()` re-runs this load.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: requireAuth(locals) });
