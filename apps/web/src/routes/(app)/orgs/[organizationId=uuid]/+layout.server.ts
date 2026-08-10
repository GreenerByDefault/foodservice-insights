import type { OrganizationId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** Settle which organization everything below this point acts on. */
export const load: LayoutServerLoad = ({ locals, params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const { organizationName, role } = requireOrganizationAccess(requireAuth(locals), organizationId);
  return { organization: { id: organizationId, name: organizationName }, role };
};
