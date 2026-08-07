/** The one user and organization the app runs as until Supabase Auth lands.
 *
 * Phase 1 has no sign-in, so these rows stand in for whoever would have been authenticated. When
 * auth arrives, delete this file along with `scripts/seed.ts`, the `seed` task in `turbo.json`,
 * and the placeholder lookup in `apps/web/src/hooks.server.ts`. Nothing else should refer to
 * these constants.
 */

import type { DatabaseExecutor } from './schema.ts';
import { withTransaction } from './transactions.ts';
import type { OrganizationId, UserId } from './types.ts';

/** Shaped like the v7 ids around them so they sort the same way, and obviously synthetic so
 * nobody mistakes one for a real row.
 */
export const PLACEHOLDER_USER_ID = '00000000-0000-7000-8000-000000000001' as UserId;
export const PLACEHOLDER_ORGANIZATION_ID = '00000000-0000-7000-8000-000000000002' as OrganizationId;

export const PLACEHOLDER_USER_EMAIL = 'phase-one@example.test';
export const PLACEHOLDER_ORGANIZATION_NAME = 'Phase One Foodservice';

/** Create the placeholder rows, or leave them exactly as they are.
 *
 * Idempotent by way of `ON CONFLICT DO NOTHING`.
 */
export async function seedPlaceholderIdentity(db: DatabaseExecutor): Promise<void> {
  // One transaction, because `organization_has_a_member` is deferred to commit: an organization
  // written on its own would fail before the membership row lands.
  await withTransaction(db, async (transaction) => {
    // The matching `app_user` row is written by the trigger on `auth.users`, not here.
    await transaction
      .insertInto('auth.users')
      .values({ id: PLACEHOLDER_USER_ID, email: PLACEHOLDER_USER_EMAIL })
      .onConflict((conflict) => conflict.doNothing())
      .execute();

    await transaction
      .insertInto('organization')
      .values({
        id: PLACEHOLDER_ORGANIZATION_ID,
        name: PLACEHOLDER_ORGANIZATION_NAME,
        createdByUserId: PLACEHOLDER_USER_ID,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();

    await transaction
      .insertInto('organizationMember')
      .values({
        userId: PLACEHOLDER_USER_ID,
        organizationId: PLACEHOLDER_ORGANIZATION_ID,
        role: 'admin',
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  });
}
