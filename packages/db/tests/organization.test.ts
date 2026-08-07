/** The auth side of the schema: users mirrored from `auth.users`, organizations, membership, and
 * invites. */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AppUser } from '../src/generated/public/AppUser.ts';
import type { OrganizationId } from '../src/generated/public/Organization.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import {
  fixtureOrganizationName,
  insertFixtureOrganization,
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
} from '../src/testing/concurrency.ts';
import { insertAppUser, insertOrganization } from '../src/testing/fixtures.ts';
import { checkDeferredConstraints, withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

type Transaction = Parameters<Parameters<typeof withRollback>[1]>[0];

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
  /** An organization and its one admin, as the app would write them: two statements in one
   * transaction, which is what `organization_has_a_member` being deferred is for. */
  async function createOrganization(
    transaction: Transaction,
    admin: AppUser,
  ): Promise<OrganizationId> {
    const organization = await transaction
      .insertInto('organization')
      .values({ name: fixtureOrganizationName(), createdByUserId: admin.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('organizationMember')
      .values({ userId: admin.id, organizationId: organization.id, role: 'admin' })
      .execute();
    return organization.id;
  }

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

  test('counts against the user who created it', async () => {
    const count = await withRollback(DATABASE, async (transaction) => {
      const { admin } = await insertOrganization(transaction);
      const user = await transaction
        .selectFrom('appUser')
        .select('organizationsCreatedCount')
        .where('id', '=', admin.id)
        .executeTakeFirstOrThrow();
      return user.organizationsCreatedCount;
    });

    expect(count).toBe(1);
  });

  test('is refused once its creator has created five', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const { admin } = await insertOrganization(transaction);
      for (let number = 2; number <= 6; number++) {
        await transaction
          .insertInto('organization')
          .values({ name: `Extra ${crypto.randomUUID()}`, createdByUserId: admin.id })
          .execute();
      }
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'app_user_organizations_created_count_max',
    });
  });

  test('refuses the second of two concurrent creations at the limit', async () => {
    // Proves the row lock in `organization_count_against_creator` (migrations/001_initial_schema.ts)
    // actually serializes: without it, both creations would read count=4 and only one increment
    // would stick, letting a sixth organization through.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const user = await insertAppUser(transaction);
        trash.user(user.id);
        await transaction
          .updateTable('appUser')
          .set({ organizationsCreatedCount: 4 })
          .where('id', '=', user.id)
          .execute();
        return user;
      },
      async (user, trash) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          const fifth = await createOrganization(alpha.transaction, user);

          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            createOrganization(transaction, user),
          );

          await alpha.transaction.commit().execute();
          trash.organization(fifth);

          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_CHECK_VIOLATION,
            constraint: 'app_user_organizations_created_count_max',
          });
        });

        const after = await DATABASE.selectFrom('appUser')
          .select('organizationsCreatedCount')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        expect(after.organizationsCreatedCount).toBe(5);
      },
    );
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
  async function demote(
    transaction: Transaction,
    organizationId: OrganizationId,
    userId: AppUser['id'],
  ): Promise<void> {
    await transaction
      .updateTable('organizationMember')
      .set({ role: 'member' })
      .where('organizationId', '=', organizationId)
      .where('userId', '=', userId)
      .execute();
  }

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
    const demoted = withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      await demote(transaction, organization.id, admin.id);
      await checkDeferredConstraints(transaction);
    });

    await expect(demoted).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'organization_member_at_least_one_admin',
    });
  });

  test('refuses the second of two concurrent demotions', async () => {
    // Neither demotion is illegitimate on its own — each leaves the other admin standing. Only
    // together do they empty the organization, and the row lock the trigger takes is the only
    // thing that can see that.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization, admin } = await insertFixtureOrganization(transaction, trash);
        const second = await insertAppUser(transaction);
        trash.user(second.id);
        await transaction
          .insertInto('organizationMember')
          .values({ userId: second.id, organizationId: organization.id, role: 'admin' })
          .execute();
        return { organizationId: organization.id, first: admin, second };
      },
      async ({ organizationId, first, second }) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          await demote(alpha.transaction, organizationId, first.id);
          // Fire alpha's deferred trigger now. It takes the organization's row lock, passes, and
          // alpha holds that lock until it commits. `<name>` rather than `ALL`, which would also
          // flip `organization_has_a_member` and every foreign key.
          await sql`SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE`.execute(
            alpha.transaction,
          );

          await demote(beta.transaction, organizationId, second.id);
          // Beta blocks inside a real COMMIT rather than a `SET CONSTRAINTS`, so what is under
          // test is the path production takes.
          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            transaction.commit().execute(),
          );

          await alpha.transaction.commit().execute();
          // Not decoration: an alpha killed by a session timeout while idle would release the
          // lock, and beta would then find an admin still standing and commit happily.
          expect(alpha.transaction.isCommitted).toBe(true);

          // Beta re-read under a fresh snapshot once the lock was granted, and saw alpha's
          // committed demotion beside its own.
          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_CHECK_VIOLATION,
            constraint: 'organization_member_at_least_one_admin',
          });
        });

        const admins = await DATABASE.selectFrom('organizationMember')
          .select('userId')
          .where('organizationId', '=', organizationId)
          .where('role', '=', 'admin')
          .execute();
        expect(admins.map((row) => row.userId)).toEqual([second.id]);
      },
    );
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
