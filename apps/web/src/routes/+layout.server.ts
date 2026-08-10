import type { LayoutServerLoad } from './$types';

/** Null is the ordinary case here, not a failure — this load must stay unguarded.
 * `(app)/+layout.server.ts` is the one place a missing identity becomes a 401, and it returns
 * `auth` non-null, so nothing inside the gate has to narrow it.
 */
export const load: LayoutServerLoad = ({ locals }) => ({ auth: locals.auth });
