import type { OrganizationId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import { database } from '$lib/server/db';
import { resolveOrganization } from '$lib/server/organizations';
import type { LayoutServerLoad } from './$types';

/** Settle which organization everything below this point acts on, once.
 *
 * *Rejected for now: a slug in place of the id.* A slug needs its own column and unique index;
 * `organization_name_unique_ci` is on `lower(name)`, and slugifying loses more than lowercasing
 * does — `Acme Foods`, `Acme  Foods` and `Acme-Foods` are three legal names and one slug — so
 * unique names would not give unique slugs. This parameter could accept either later.
 */
export const load: LayoutServerLoad = async ({ locals, params }) =>
  await resolveOrganization(
    database(),
    requireAuth(locals),
    params.organizationId as OrganizationId,
  );
