import type { LayoutServerLoad } from './$types';

/** Whether anyone is signed in, for the pages outside the `(app)` gate — the marketing page,
 * sign-in, and the error boundary that offers sign-in in place.
 *
 * Null is the ordinary case here rather than a failure, so this load must stay unguarded.
 * `(app)/+layout.server.ts` is the one place a missing identity becomes a 401, and it returns
 * `auth` again non-null, so nothing inside the gate has to narrow it.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: locals.auth });
