import { requireAuth } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * Children can run `const { auth } = await parent()` to load the user.
 *
 * Keep this load function to avoid slowing down children.
 *
 * Once there is a sign-in page, the 401 inside `requireAuth` will become a redirect to it.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: requireAuth(locals) });
