import type {
  Database,
  OrganizationId,
  OrganizationInviteStatus,
  OrganizationRole,
  UserId,
} from '@gbd/db';
import {
  insertAppUser,
  insertAppUserWithEmail,
  insertOrganization,
  insertOrganizationMember,
  withRollback,
} from '@gbd/db/testing';
import { unreachableEmailer } from '@gbd/email/testing';
import { type BlobStore, deletePrefix, organizationPrefix } from '@gbd/storage';
import type { Transaction } from 'kysely';
import type { Actor, AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';
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

/** An `OrganizationAccess` for an organization named `name`, with `member` role and a random id
 * unless overridden. */
export function anOrganizationAccess(
  name: string,
  role: OrganizationRole = 'member',
  organizationId: OrganizationId = crypto.randomUUID() as OrganizationId,
): OrganizationAccess {
  return { organizationId, organizationName: name, role };
}

/** A user inserted for use as an organization's creator. */
export async function anOrganizationCreator(
  transaction: Parameters<typeof insertAppUserWithEmail>[0],
): Promise<{ actor: Actor; actorEmail: string }> {
  const user = await insertAppUserWithEmail(transaction);
  return { actor: { userId: user.id, role: 'admin' }, actorEmail: user.email };
}

/** An organization with one member row per entry in `roles`, in order — the
 * `insertOrganization` + `insertAppUser` + `insertOrganizationMember` sequence that member-listing
 * tests otherwise repeat per case. */
export async function anOrganizationWithMembers(
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

/** An invite for `email` that runs out at `expiresAt`.
 *
 * `created_at` is backdated a full invite lifetime rather than left to default, because
 * `organization_invite_expires_at_after_created_at` refuses a row that is already expired the
 * moment it is written — so this is also the only way to build the expired case.
 */
export async function inviteExpiring(
  transaction: Transaction<Database>,
  email: string,
  expiresAt: Date,
  status: OrganizationInviteStatus = 'pending',
): Promise<void> {
  const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
  const { organization } = await insertOrganization(transaction);

  await transaction
    .insertInto('organizationInvite')
    .values({
      organizationId: organization.id,
      email,
      role: 'member',
      status,
      createdAt: new Date(expiresAt.getTime() - INVITE_LIFETIME_MS),
      expiresAt,
    })
    .execute();
}

/** A unique address per call, so no test can see another's invite. */
export function anEmail(): string {
  return `${crypto.randomUUID()}@example.test`;
}

/** A `vi.mock('$lib/server/email', ...)` factory aimed at a port nothing listens on, so a test
 * proves `notifyGbd`'s own catch rather than depending on whatever Mailpit happens to be doing
 * locally.
 *
 * Use as `vi.mock('$lib/server/email', (importOriginal) => mockUnreachableEmailer(importOriginal))`
 * — not a bare reference, which vi.mock's hoisting evaluates before this import is initialized. */
export async function mockUnreachableEmailer(
  importOriginal: () => Promise<typeof import('../email.ts')>,
): Promise<typeof import('../email.ts')> {
  const actual = await importOriginal();
  return { ...actual, emailer: () => unreachableEmailer() };
}

export type OrganizationFixtures = {
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
        adminUserId: admin.id,
      });
    } finally {
      await deletePrefix(blobStore(), organizationPrefix(organization.id));
    }
  });
}
