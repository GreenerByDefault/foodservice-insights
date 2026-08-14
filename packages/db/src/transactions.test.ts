import { describe, expect, test } from 'vitest';
import { DATABASE } from './env.ts';
import { insertOrganization } from './testing/fixtures.ts';
import { withRollback } from './testing/transactions.ts';
import { withTransaction } from './transactions.ts';
import type { OrganizationId } from './types.ts';

async function organizationExists(id: OrganizationId): Promise<boolean> {
  const row = await DATABASE.selectFrom('organization')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  return row !== undefined;
}

describe('withTransaction', () => {
  test('given the pool, opens a transaction that rolls back as a unit', async () => {
    let organizationId: OrganizationId | undefined;

    const attempt = withTransaction(DATABASE, async (transaction) => {
      organizationId = (await insertOrganization(transaction)).organization.id;
      throw new Error('boom');
    });

    await expect(attempt).rejects.toThrow('boom');
    if (!organizationId) throw new Error('the transaction body never ran');
    // Nothing survived, so the two inserts `insertOrganization` makes were one unit of work.
    expect(await organizationExists(organizationId)).toBe(false);
  });

  test('given a transaction, joins it rather than nesting', async () => {
    // This proves joining works, not atomicity — everything here rolls back regardless
    // of whether insertOrganization's two inserts were one unit of work. See the test above.
    const organizationId = await withRollback(DATABASE, async (outer) => {
      const id = await withTransaction(outer, async (inner) => {
        // The same handle, which is the whole point: Kysely throws on a nested transaction.
        expect(inner).toBe(outer);
        return (await insertOrganization(inner)).organization.id;
      });

      // Written by the inner call and readable from the outer one, so no separate transaction
      // committed it away.
      const visible = await outer
        .selectFrom('organization')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      expect(visible).toBeDefined();

      return id;
    });

    expect(await organizationExists(organizationId)).toBe(false);
  });
});
