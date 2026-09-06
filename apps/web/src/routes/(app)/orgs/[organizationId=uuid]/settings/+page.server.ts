import type { OrganizationId } from '@gbd/db';
import { requireAuth, requireOrganizationAdmin } from '$lib/server/auth/guards';
import { database } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** The layout above only 404s someone with no access to the organization at all — a member
 * passes it fine. Everything on this page is admin-only, so it needs its own check.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  await requireOrganizationAdmin(
    database(),
    requireAuth(locals),
    params.organizationId as OrganizationId,
  );
};
