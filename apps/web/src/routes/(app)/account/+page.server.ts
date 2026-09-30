import type { DatabaseExecutor, UserId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** The user comes from the `(app)` layout. */
export const load: PageServerLoad = async ({ locals }) => {
  const { user } = requireAuth(locals);

  return {
    soleAdminOrganizations: await withDbErrorHandling(
      () => _loadSoleAdminOrganizations(database(), user.id),
      {
        action: 'load the organizations a user is the only admin of',
        context: { userId: user.id },
      },
    ),
  };
};

export type SoleAdminOrganization = { slug: string; name: string };

/** The organizations `userId` is the only admin of, by name: each one blocks deleting the account
 * until they promote someone or delete it. */
export async function _loadSoleAdminOrganizations(
  db: DatabaseExecutor,
  userId: UserId,
): Promise<SoleAdminOrganization[]> {
  return await db
    .selectFrom('organizationMember as mine')
    .innerJoin('organization', 'organization.id', 'mine.organizationId')
    .select(['organization.slug', 'organization.name'])
    .where('mine.userId', '=', userId)
    .where('mine.role', '=', 'admin')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('organizationMember as other')
            .select('other.userId')
            .whereRef('other.organizationId', '=', 'mine.organizationId')
            .where('other.role', '=', 'admin')
            .where('other.userId', '!=', userId),
        ),
      ),
    )
    .orderBy('organization.name')
    .execute();
}
