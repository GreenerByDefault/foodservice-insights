import type { Database, OrganizationId, UserId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import type { AuthContext, AuthenticatedUser, Membership } from '../auth/types.ts';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

/** An `AuthContext` with no database behind it. */
export function anAuthContext(
  overrides: { user?: Partial<AuthenticatedUser>; memberships?: readonly Membership[] } = {},
): AuthContext {
  return {
    user: {
      id: crypto.randomUUID() as UserId,
      email: 'member@example.test',
      displayName: null,
      isSuperadmin: false,
      ...overrides.user,
    },
    memberships: overrides.memberships ?? [],
  };
}

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
