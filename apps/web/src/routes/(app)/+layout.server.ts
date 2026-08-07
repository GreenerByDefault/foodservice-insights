import { requireAuth } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** The gate for everything inside `(app)`: a request gets no further without an identity.
 *
 * Returning the context, rather than only checking it, is what lets a child `load` write
 * `const { auth } = await parent()` and get a value TypeScript knows is not null.
 *
 * Keep this fast. Every child that awaits `parent()` waits on it.
 *
 * Once there is a sign-in page, the 401 inside `requireAuth` becomes a redirect to it.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: requireAuth(locals) });
