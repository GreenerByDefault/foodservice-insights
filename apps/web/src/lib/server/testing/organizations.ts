import type { Database, OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import {
  insertAppUser,
  insertAppUserWithEmail,
  insertOrganization,
  insertOrganizationMember,
  withRollback,
} from '@gbd/db/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import type { Actor } from '../auth/types.ts';
import { database } from '../db.ts';
import { blobStore } from '../storage.ts';

/** A user inserted for use as an organization's creator. */
export async function insertOrganizationCreator(
  transaction: Parameters<typeof insertAppUserWithEmail>[0],
): Promise<{ actor: Actor; actorEmail: string }> {
  const user = await insertAppUserWithEmail(transaction);
  return { actor: { userId: user.id, role: 'admin' }, actorEmail: user.email };
}

/** An organization with one member row per entry in `roles`, in order — the
 * `insertOrganization` + `insertAppUser` + `insertOrganizationMember` sequence that member-listing
 * tests otherwise repeat per case. */
export async function insertOrganizationWithMembers(
  transaction: Transaction<Database>,
  roles: { role: OrganizationRole; displayName?: string; email?: string }[],
): Promise<{ organizationId: OrganizationId; admin: UserId; members: UserId[] }> {
  const { organization, admin } = await insertOrganization(transaction);

  const members: UserId[] = [];
  for (const { role, displayName, email } of roles) {
    const user = await insertAppUser(transaction, { displayName, email });
    await insertOrganizationMember(transaction, {
      organizationId: organization.id,
      userId: user.id,
      role,
    });
    members.push(user.id as UserId);
  }

  return { organizationId: organization.id, admin: admin.id as UserId, members };
}

/** An organization and its sole admin, acting as themselves — the preamble for tests that don't
 * need a second member. */
export async function insertAdminOrg(
  transaction: Transaction<Database>,
): Promise<{ organizationId: OrganizationId; admin: UserId; actor: Actor }> {
  const { organizationId, admin } = await insertOrganizationWithMembers(transaction, []);
  return { organizationId, admin, actor: { userId: admin, role: 'admin' } };
}

export type OrganizationFixtures = {
  transaction: Transaction<Database>;
  store: BlobStore;
  organizationId: OrganizationId;
  organizationSlug: string;
  adminUserId: UserId;
};

/** Run `fn` against a real organization, and undo everything it wrote.
 *
 * Two cleanups, because the two stores need different ones: `withRollback` for the rows, and a
 * prefix delete for the objects, which no transaction can reach.
 */
export async function withOrganizationFixtures<T>(
  fn: (fixtures: OrganizationFixtures) => Promise<T>,
): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    const { organization, admin } = await insertOrganization(transaction);

    try {
      return await fn({
        transaction,
        store: blobStore(),
        organizationId: organization.id,
        organizationSlug: organization.slug,
        adminUserId: admin.id,
      });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}
