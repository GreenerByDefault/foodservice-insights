import { requireOrganizationRouteContext } from '$lib/server/auth/route-context';
import { database } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** The layout above only 404s someone with no access to the organization at all — a member
 * passes it fine. Everything on this page is admin-only, so it needs its own check.
 */
export const load: PageServerLoad = async (event) => {
  await requireOrganizationRouteContext(database(), event, { admin: true });
};
