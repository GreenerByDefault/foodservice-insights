import type { Database, OrganizationId, UserId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import type { AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

/** An `AuthContext` with no database behind it. */
export function anAuthContext(
  overrides: {
    user?: Partial<AuthenticatedUser>;
    organizations?: readonly OrganizationAccess[];
  } = {},
): AuthContext {
  return {
    user: {
      id: crypto.randomUUID() as UserId,
      email: 'member@example.test',
      displayName: null,
      isSuperadmin: false,
      ...overrides.user,
    },
    organizations: overrides.organizations ?? [],
  };
}

export type FileFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  organizationId: OrganizationId;
  /** The organization's admin, which `insertOrganization` has to create anyway. Anything a test
   * attributes to a user — an upload, a report — can use this rather than making a second one.
   */
  userId: UserId;
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
        userId: admin.id,
      });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}
