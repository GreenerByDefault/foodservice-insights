import type { OrganizationId, UserId } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID, PLACEHOLDER_ORGANIZATION_NAME } from '@gbd/db/seed';
import { insertAppUser, insertOrganization, withRollback } from '@gbd/db/testing';
import { afterAll, describe, expect, test } from 'vitest';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { closeDatabase, database } from '../db.ts';
import { findOrganizationAccess, loadAuthorization } from './authorization.ts';

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
        organizations: [
          { organizationId: organization.id, organizationName: 'Acme Foods', role: 'admin' },
        ],
      });
      expect(auth?.user.email).toMatch(/@example\.test$/);
    });
  });

  test('orders organizations by name, so a switcher is stable', async () => {
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

      expect(auth?.organizations.map((access) => access.organizationName)).toEqual([
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

      expect(auth).toMatchObject({ user: { id: user.id }, organizations: [] });
    });
  });

  test('does not see an organization the user does not belong to', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction);
      const outsider = await insertAppUser(transaction);

      const auth = await loadAuthorization(transaction, outsider.id);

      expect(auth?.organizations).toEqual([]);
    });
  });

  test('gives a superadmin admin over organizations they hold no membership in', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: apple } = await insertOrganization(transaction, { name: 'Apple Co' });
      const { organization: mango } = await insertOrganization(transaction, { name: 'Mango Co' });
      const superadmin = await insertAppUser(transaction, { isSuperadmin: true });

      const auth = await loadAuthorization(transaction, superadmin.id);

      expect(auth?.organizations).toEqual([
        { organizationId: apple.id, organizationName: 'Apple Co', role: 'admin' },
        { organizationId: mango.id, organizationName: 'Mango Co', role: 'admin' },
        // Remove this entry once removing PLACEHOLDER_ORGANIZATION_ID.
        {
          organizationId: PLACEHOLDER_ORGANIZATION_ID,
          organizationName: PLACEHOLDER_ORGANIZATION_NAME,
          role: 'admin',
        },
      ]);
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

describe('findOrganizationAccess', () => {
  test('finds the access the user holds', () => {
    const access = {
      organizationId: ORGANIZATION_ID,
      organizationName: 'Acme Foods',
      role: 'member',
    } as const;

    expect(
      findOrganizationAccess(anAuthContext({ organizations: [access] }), ORGANIZATION_ID),
    ).toBe(access);
  });

  test('is undefined where the user has none', () => {
    expect(findOrganizationAccess(anAuthContext(), ORGANIZATION_ID)).toBeUndefined();
  });
});
