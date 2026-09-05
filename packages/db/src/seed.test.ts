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
