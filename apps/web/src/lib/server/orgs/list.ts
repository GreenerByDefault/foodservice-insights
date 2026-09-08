import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import type { AuthContext } from '$lib/server/auth/types';
import { withDbErrorHandling } from '$lib/server/db';

export type OrganizationRow = { id: OrganizationId; name: string };

/** Every organization this user may pick, name-ordered.
 *
 * A superadmin reads the `organization` table itself, alphabetically. Everyone else already holds
 * their full membership list in `auth.memberships` (see `memberOrganizations`), so no query runs
 * for them. `limit` bounds the switcher's read; the full `/orgs` picker omits it.
 */
export async function listOrganizations(
  db: DatabaseExecutor,
  auth: AuthContext,
  { limit }: { limit?: number } = {},
): Promise<readonly OrganizationRow[]> {
  if (!auth.user.isSuperadmin) {
    const rows = auth.memberships.map((membership) => ({
      id: membership.organizationId,
      name: membership.organizationName,
    }));
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  return await withDbErrorHandling(
    () => {
      const query = db.selectFrom('organization').select(['id', 'name']).orderBy('name');
      return (limit === undefined ? query : query.limit(limit)).execute();
    },
    { action: 'list organizations', context: { userId: auth.user.id } },
  );
}
