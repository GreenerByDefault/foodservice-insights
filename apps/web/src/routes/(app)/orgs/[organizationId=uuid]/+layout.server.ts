import type { OrganizationId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/** Settle which organization everything below this point acts on. */
export const load: LayoutServerLoad = async ({ locals, params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const { organizationName, role } = await requireOrganizationAccess(
    database(),
    requireAuth(locals),
    organizationId,
  );
  return { organization: { id: organizationId, name: organizationName }, role };
};
