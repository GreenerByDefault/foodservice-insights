import type { OrganizationId, UserId } from '@gbd/db';
import { insertAppUser, insertOrganization, withRollback } from '@gbd/db/testing';
import { afterAll, describe, expect, test } from 'vitest';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { closeDatabase, database } from '../db.ts';
import { effectiveRole, loadAuthorization } from './authorization.ts';

afterAll(async () => {
  await closeDatabase();
});

describe('loadAuthorization', () => {
  test('returns the user and the organization they administer', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction, { name: 'Acme Foods' });

      const auth = await loadAuthorization(transaction, admin.id);

      expect(auth).toMatchObject({
        user: { id: admin.id, isSuperadmin: false },
        memberships: [
          { organizationId: organization.id, organizationName: 'Acme Foods', role: 'admin' },
        ],
      });
      expect(auth?.user.email).toMatch(/@example\.test$/);
    });
  });

  test('orders memberships by organization name, so a switcher is stable', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction);
      for (const name of ['Zucchini Co', 'Apple Co', 'Mango Co']) {
        const { organization } = await insertOrganization(transaction, { name });
        await transaction
          .insertInto('organizationMember')
          .values({ userId: user.id, organizationId: organization.id, role: 'member' })
          .execute();
      }

      const auth = await loadAuthorization(transaction, user.id);

      expect(auth?.memberships.map((membership) => membership.organizationName)).toEqual([
        'Apple Co',
        'Mango Co',
        'Zucchini Co',
      ]);
    });
  });

  test('carries the display name and superadmin flag', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction, {
        displayName: 'Dana Cook',
        isSuperadmin: true,
      });

      const auth = await loadAuthorization(transaction, user.id);

      expect(auth?.user).toMatchObject({ displayName: 'Dana Cook', isSuperadmin: true });
    });
  });

  test('gives a user with no organizations an identity and an empty list', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction);

      const auth = await loadAuthorization(transaction, user.id);

      expect(auth).toMatchObject({ user: { id: user.id }, memberships: [] });
    });
  });

  test("does not see another user's memberships", async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction);
      const outsider = await insertAppUser(transaction);

      const auth = await loadAuthorization(transaction, outsider.id);

      expect(auth?.memberships).toEqual([]);
    });
  });

  test('returns null for a user who does not exist', async () => {
    await withRollback(database(), async (transaction) => {
      const auth = await loadAuthorization(transaction, crypto.randomUUID() as UserId);

      expect(auth).toBeNull();
    });
  });

  test('throws rather than yielding a user without an email', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction);
      await transaction
        .updateTable('auth.users')
        .set({ email: null })
        .where('id', '=', user.id)
        .execute();

      await expect(loadAuthorization(transaction, user.id)).rejects.toThrow(/has no email/);
    });
  });
});

const ORGANIZATION_ID = crypto.randomUUID() as OrganizationId;

describe('effectiveRole', () => {
  test('is the role on the membership', () => {
    const auth = anAuthContext({
      memberships: [
        { organizationId: ORGANIZATION_ID, organizationName: 'Acme Foods', role: 'member' },
      ],
    });

    expect(effectiveRole(auth, ORGANIZATION_ID)).toBe('member');
  });

  test('is null where there is no membership', () => {
    expect(effectiveRole(anAuthContext(), ORGANIZATION_ID)).toBeNull();
  });

  test('is admin for a superadmin, who holds no membership anywhere', () => {
    const superadmin = anAuthContext({ user: { isSuperadmin: true } });

    expect(superadmin.memberships).toEqual([]);
    expect(effectiveRole(superadmin, ORGANIZATION_ID)).toBe('admin');
  });

  test('is admin for a superadmin even where they are only a member', () => {
    const auth = anAuthContext({
      user: { isSuperadmin: true },
      memberships: [
        { organizationId: ORGANIZATION_ID, organizationName: 'Acme Foods', role: 'member' },
      ],
    });

    expect(effectiveRole(auth, ORGANIZATION_ID)).toBe('admin');
  });
});
