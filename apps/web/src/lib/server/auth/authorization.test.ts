import type { UserId } from '@gbd/db';
import { insertAppUser, insertOrganization, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '../db.ts';
import { loadAuthorization } from './authorization.ts';

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

      expect(auth?.memberships.map((access) => access.organizationName)).toEqual([
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

  test('does not see an organization the user does not belong to', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction);
      const outsider = await insertAppUser(transaction);

      const auth = await loadAuthorization(transaction, outsider.id);

      expect(auth?.memberships).toEqual([]);
    });
  });

  test('gives a superadmin their own memberships, not every organization', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction, { name: 'Apple Co' });
      const { organization: mango, admin: superadmin } = await insertOrganization(transaction, {
        name: 'Mango Co',
      });
      await transaction
        .updateTable('appUser')
        .set({ isSuperadmin: true })
        .where('id', '=', superadmin.id)
        .execute();

      const auth = await loadAuthorization(transaction, superadmin.id);

      // A superadmin's memberships are exactly the organizations they hold a genuine
      // `organization_member` row in — creating Mango Co enrolled them there — never the whole
      // table. `requireOrganizationAccess` is what grants them access beyond this list.
      expect(auth?.memberships).toEqual([
        { organizationId: mango.id, organizationName: 'Mango Co', role: 'admin' },
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
