import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/** Settle which organization everything below this point acts on. */
export const load: LayoutServerLoad = async ({ locals, params }) => {
  const { organizationId, organizationSlug, organizationName, role } =
    await requireOrganizationAccess(database(), requireAuth(locals), params.organizationSlug);
  return {
    organization: { id: organizationId, slug: organizationSlug, name: organizationName },
    role,
  };
};
