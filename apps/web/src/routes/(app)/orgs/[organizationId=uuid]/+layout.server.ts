import type { OrganizationId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import type { LayoutServerLoad } from './$types';

/** Settle which organization everything below this point acts on, once.
 *
 * *Rejected for now: a slug in place of the id.* A slug needs its own column and unique index;
 * `organization_name_unique_ci` is on `lower(name)`, and slugifying loses more than lowercasing
 * does — `Acme Foods`, `Acme  Foods` and `Acme-Foods` are three legal names and one slug — so
 * unique names would not give unique slugs. This parameter could accept either later.
 */
export const load: LayoutServerLoad = ({ locals, params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const { organizationName, role } = requireOrganizationAccess(requireAuth(locals), organizationId);

  return { organization: { id: organizationId, name: organizationName }, role };
};
