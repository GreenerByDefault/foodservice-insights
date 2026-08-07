/** What a test of a file route needs before it can call one: an organization that exists in the
 * database, and a blob store whose objects get cleaned up.
 *
 * Not a `.test.ts` file, so no runner picks it up.
 *
 * There is no `Session` here, unlike the auth PR's eventual fixtures — these routes are
 * deliberately unauthenticated, per ARCHITECTURE.md § File links. Once that PR lands and needs its
 * own `withReportFixtures`-style helper with a session, reconcile the two rather than keeping this
 * as a second, parallel one.
 */

import type { Database, OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

export type FileFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  organizationId: OrganizationId;
};

/** Run `fn` against a real organization, and undo everything it wrote.
 *
 * Two cleanups, because the two stores need different ones: `withRollback` for the rows, and a
 * prefix delete for the objects, which no transaction can reach.
 */
export async function withFileFixtures<T>(fn: (fixtures: FileFixtures) => Promise<T>): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    const { organization } = await insertOrganization(transaction);

    try {
      return await fn({ transaction, store: blobStore(), organizationId: organization.id });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}
