import type { Database, OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import { insertAppUserWithEmail, insertOrganization, withRollback } from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import type { AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

/** An `AuthContext` with no database behind it. */
export function anAuthContext(
  overrides: {
    user?: Partial<AuthenticatedUser>;
    memberships?: readonly OrganizationAccess[];
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
    memberships: overrides.memberships ?? [],
  };
}

/** An `OrganizationAccess` for an organization named `name`, with a random id and `member` role
 * unless overridden. */
export function anOrganizationAccess(
  name: string,
  role: OrganizationRole = 'member',
): OrganizationAccess {
  return {
    organizationId: crypto.randomUUID() as OrganizationId,
    organizationName: name,
    role,
  };
}

/** A user inserted for use as an organization's creator. */
export async function anOrganizationCreator(
  transaction: Parameters<typeof insertAppUserWithEmail>[0],
): Promise<{ userId: UserId; actorEmail: string }> {
  const user = await insertAppUserWithEmail(transaction);
  return { userId: user.id, actorEmail: user.email };
}

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
