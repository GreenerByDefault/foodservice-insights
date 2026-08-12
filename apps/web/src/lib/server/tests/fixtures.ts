import type { Database, OrganizationId, UserId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

export type FileFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  organizationId: OrganizationId;
  adminUserId: UserId;
};

/** Run `fn` against a real organization, and undo everything it wrote.
 *
 * Two cleanups, because the two stores need different ones: `withRollback` for the rows, and a
 * prefix delete for the objects, which no transaction can reach.
 */
export async function withFileFixtures<T>(fn: (fixtures: FileFixtures) => Promise<T>): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    const { organization, admin } = await insertOrganization(transaction);

    try {
      return await fn({
        transaction,
        store: blobStore(),
        organizationId: organization.id,
        adminUserId: admin.id,
      });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}
