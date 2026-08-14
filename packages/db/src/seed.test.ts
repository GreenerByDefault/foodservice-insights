import { describe, expect, test } from 'vitest';
import { DATABASE } from './env.ts';
import {
  PLACEHOLDER_ORGANIZATION_ID,
  PLACEHOLDER_USER_ID,
  seedPlaceholderIdentity,
} from './seed.ts';
import { checkDeferredConstraints, withRollback } from './testing/transactions.ts';

describe('seedPlaceholderIdentity', () => {
  test('is idempotent', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await seedPlaceholderIdentity(transaction);
      await seedPlaceholderIdentity(transaction);

      const memberships = await transaction
        .selectFrom('organizationMember')
        .selectAll()
        .where('userId', '=', PLACEHOLDER_USER_ID)
        .execute();
      expect(memberships).toMatchObject([
        { organizationId: PLACEHOLDER_ORGANIZATION_ID, role: 'admin' },
      ]);

      // The count is what a re-seed would quietly corrupt: an upsert instead of DO NOTHING
      // would re-fire `organization_count_against_creator` and, after five runs, make seeding
      // fail against `app_user_organizations_created_count_max`.
      const user = await transaction
        .selectFrom('appUser')
        .select('organizationsCreatedCount')
        .where('id', '=', PLACEHOLDER_USER_ID)
        .executeTakeFirstOrThrow();
      expect(user.organizationsCreatedCount).toBe(1);
    });
  });

  test('satisfies the deferred constraints it defers', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await seedPlaceholderIdentity(transaction);

      // `organization_has_a_member` is a deferred constraint trigger, so it would otherwise
      // fire at a COMMIT this test never reaches. Forcing it here is what makes the test cover
      // the reason `seedPlaceholderIdentity` needs a transaction at all.
      await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
    });
  });
});
