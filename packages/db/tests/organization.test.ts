/** The auth side of the schema: users mirrored from `auth.users`, organizations, membership, and
 * invites. */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AppUser } from '../src/generated/public/AppUser.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import { insertAppUser, insertOrganization } from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

/** Force the deferred constraint triggers to run now rather than at a commit that never comes. */
async function checkDeferredConstraints(
  transaction: Parameters<Parameters<typeof withRollback>[1]>[0],
) {
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(transaction);
}

describe('app_user', () => {
  test('is created by a trigger when auth.users gains a row', async () => {
    const user = await withRollback(DATABASE, async (transaction) => {
      return await insertAppUser(transaction, { displayName: 'Ada Lovelace' });
    });

    expect(user).toMatchObject({
      displayName: 'Ada Lovelace',
      isSuperadmin: false,
      organizationsCreatedCount: 0,
    });
  });

  test('is deleted with the auth.users row it mirrors', async () => {
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      await transaction.deleteFrom('auth.users').where('id', '=', user.id).execute();
      return await transaction
        .selectFrom('appUser')
        .select('id')
        .where('id', '=', user.id)
        .executeTakeFirst();
    });

    expect(remaining).toBeUndefined();
  });

  test('cannot have created a negative number of organizations', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      await transaction
        .updateTable('appUser')
        .set({ organizationsCreatedCount: -1 })
        .where('id', '=', user.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'app_user_organizations_created_count_non_negative',
    });
  });

  test('cannot have created more than 5 organizations', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      await transaction
        .updateTable('appUser')
        .set({ organizationsCreatedCount: 6 })
        .where('id', '=', user.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'app_user_organizations_created_count_max',
    });
  });

  test('cannot exist without an auth.users row', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await transaction
        .insertInto('appUser')
        .values({ id: crypto.randomUUID() as AppUser['id'] })
        .execute();
    });

    await expect(insert).rejects.toMatchObject({ code: POSTGRES_CODE_FOREIGN_KEY_VIOLATION });
  });
});

describe('organization', () => {
  test('rejects a duplicate name', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const name = `Duplicate ${crypto.randomUUID()}`;
      await insertOrganization(transaction, { name });
      await insertOrganization(transaction, { name });
    });

    await expect(insert).rejects.toMatchObject({ code: POSTGRES_CODE_UNIQUE_VIOLATION });
  });

  test('rejects a name that is a duplicate only by case', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const suffix = crypto.randomUUID();
      await insertOrganization(transaction, { name: `Acme ${suffix}` });
      await insertOrganization(transaction, { name: `acme ${suffix}` });
    });

    await expect(insert).rejects.toMatchObject({ code: POSTGRES_CODE_UNIQUE_VIOLATION });
  });

  test('cannot be created with no members at all', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await transaction
        .insertInto('organization')
        .values({ name: `Empty ${crypto.randomUUID()}` })
        .execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_has_a_member',
    });
  });

  test('cannot be created with members but no admin among them', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      const organization = await transaction
        .insertInto('organization')
        .values({ name: `Leaderless ${crypto.randomUUID()}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('organizationMember')
        .values({ userId: user.id, organizationId: organization.id, role: 'member' })
        .execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });
});

describe('organization_member', () => {
  test('its at-least-one-admin trigger is deferred to commit', async () => {
    // Not provocable from a single transaction: this is a property of the trigger's definition,
    // not of a row. `withRollback` never commits, which is exactly why every test above that
    // relies on the deferral has to force it with `checkDeferredConstraints` — asserting the
    // definition here is what stops a refactor making it immediate (and those tests silently
    // asserting nothing) without anyone noticing.
    const rows = await withRollback(DATABASE, async (transaction) => {
      const result = await sql<{ name: string; deferrable: boolean; deferred: boolean }>`
        SELECT tgname AS name, tgdeferrable AS deferrable, tginitdeferred AS deferred
        FROM pg_trigger
        WHERE tgname IN ('organization_member_at_least_one_admin', 'organization_has_a_member')
        ORDER BY tgname
      `.execute(transaction);
      return result.rows;
    });

    expect(rows).toEqual([
      { name: 'organization_has_a_member', deferrable: true, deferred: true },
      { name: 'organization_member_at_least_one_admin', deferrable: true, deferred: true },
    ]);
  });

  test('rejects removing the last admin', async () => {
    const remove = withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      // A plain member stays behind, so this is about losing the *admin* rather than about
      // emptying the organization, which is a different rule.
      const survivor = await insertAppUser(transaction);
      await transaction
        .insertInto('organizationMember')
        .values({ userId: survivor.id, organizationId: organization.id, role: 'member' })
        .execute();

      await transaction
        .deleteFrom('organizationMember')
        .where('organizationId', '=', organization.id)
        .where('userId', '=', admin.id)
        .execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(remove).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });

  test('rejects demoting the last admin', async () => {
    const demote = withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      await transaction
        .updateTable('organizationMember')
        .set({ role: 'member' })
        .where('organizationId', '=', organization.id)
        .where('userId', '=', admin.id)
        .execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(demote).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });

  test('permits handing the role over, demoting before promoting', async () => {
    // The point of deferring: an immediate trigger would reject the demotion, forcing callers to
    // order their statements to suit the constraint rather than the operation.
    const roles = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const successor = await insertAppUser(transaction);

      await transaction
        .updateTable('organizationMember')
        .set({ role: 'member' })
        .where('organizationId', '=', organization.id)
        .where('userId', '=', admin.id)
        .execute();
      await transaction
        .insertInto('organizationMember')
        .values({ userId: successor.id, organizationId: organization.id, role: 'admin' })
        .execute();

      await checkDeferredConstraints(transaction);

      return await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organization.id)
        .orderBy('role')
        .execute();
    });

    expect(roles).toEqual([{ role: 'member' }, { role: 'admin' }]);
  });

  test('does not fire when the organization itself is deleted', async () => {
    // Deleting an organization cascades to its members, which queues the trigger. It has to tell
    // "this organization is gone" apart from "this organization lost its last admin".
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();
      await checkDeferredConstraints(transaction);

      return await transaction
        .selectFrom('organizationMember')
        .select('userId')
        .where('organizationId', '=', organization.id)
        .execute();
    });

    expect(remaining).toEqual([]);
  });

  test('blocks deleting a user who is an organization’s only admin', async () => {
    // A consequence of the cascade chain auth.users -> app_user -> organization_member, and the
    // reason REQUIREMENTS.md makes an admin promote a successor before deleting their account.
    const remove = withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const survivor = await insertAppUser(transaction);
      await transaction
        .insertInto('organizationMember')
        .values({ userId: survivor.id, organizationId: organization.id, role: 'member' })
        .execute();

      await transaction.deleteFrom('auth.users').where('id', '=', admin.id).execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(remove).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });

  test('does not count a superadmin as an organization’s admin', async () => {
    // Superadmins are admins everywhere but fill no organization's admin seat, so one cannot be
    // what keeps an organization compliant.
    const demote = withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const superadmin = await insertAppUser(transaction, { isSuperadmin: true });
      await transaction
        .insertInto('organizationMember')
        .values({ userId: superadmin.id, organizationId: organization.id, role: 'member' })
        .execute();

      await transaction
        .updateTable('organizationMember')
        .set({ role: 'member' })
        .where('organizationId', '=', organization.id)
        .where('userId', '=', admin.id)
        .execute();
      await checkDeferredConstraints(transaction);
    });

    await expect(demote).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });

  test('counts a superadmin as an organization’s admin when they hold the seat themselves', async () => {
    // The mirror image of the previous test: is_superadmin never enters the trigger's query, so
    // nothing stops a superadmin from also being a plain admin — the seat a regular user fills
    // when they create an organization. Demoting the *other* admin should succeed because the
    // superadmin's own admin row keeps the organization compliant.
    const roles = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const superadmin = await insertAppUser(transaction, { isSuperadmin: true });
      await transaction
        .insertInto('organizationMember')
        .values({ userId: superadmin.id, organizationId: organization.id, role: 'admin' })
        .execute();

      await transaction
        .updateTable('organizationMember')
        .set({ role: 'member' })
        .where('organizationId', '=', organization.id)
        .where('userId', '=', admin.id)
        .execute();
      await checkDeferredConstraints(transaction);

      return await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organization.id)
        .orderBy('role')
        .execute();
    });

    expect(roles).toEqual([{ role: 'member' }, { role: 'admin' }]);
  });
});

describe('organization_invite', () => {
  function anInvite(organizationId: string, email: string) {
    return {
      organizationId: organizationId as never,
      email,
      role: 'member' as const,
      status: 'pending' as const,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    };
  }

  test('rejects an address that is not already lowercased', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction
        .insertInto('organizationInvite')
        .values(anInvite(organization.id, 'Ada@Example.Test'))
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_invite_email_is_lowercase',
    });
  });

  test('rejects an expiry that precedes creation', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction
        .insertInto('organizationInvite')
        .values({
          ...anInvite(organization.id, 'ada@example.test'),
          expiresAt: new Date('2020-01-01T00:00:00Z'),
        })
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_invite_expires_at_after_created_at',
    });
  });

  test('allows only one pending invite per address', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction
        .insertInto('organizationInvite')
        .values(anInvite(organization.id, 'ada@example.test'))
        .execute();
      await transaction
        .insertInto('organizationInvite')
        .values(anInvite(organization.id, 'ada@example.test'))
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_UNIQUE_VIOLATION,
      constraint: 'organization_invite_one_pending_per_email',
    });
  });

  test('lets a resent invite supersede a live one', async () => {
    // Re-inviting restarts the clock on a new row. The uniqueness is partial, so the superseded row
    // survives as the audit trail rather than being overwritten.
    const statuses = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await transaction
        .insertInto('organizationInvite')
        .values(anInvite(organization.id, 'ada@example.test'))
        .execute();

      await transaction
        .updateTable('organizationInvite')
        .set({ status: 'superseded' })
        .where('organizationId', '=', organization.id)
        .where('email', '=', 'ada@example.test')
        .where('status', '=', 'pending')
        .execute();
      await transaction
        .insertInto('organizationInvite')
        .values(anInvite(organization.id, 'ada@example.test'))
        .execute();

      return await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('organizationId', '=', organization.id)
        .orderBy('createdAt')
        .execute();
    });

    expect(statuses.map((row) => row.status)).toEqual(['superseded', 'pending']);
  });
});
