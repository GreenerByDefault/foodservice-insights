import {
  insertAppUser,
  insertOrganization,
  insertOrganizationMember,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '#lib/server/db.js';
import { _loadSoleAdminOrganizations } from './+page.server.ts';

describe('_loadSoleAdminOrganizations', () => {
  test('lists only the organizations where the user is the one admin, by name', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction);
      const suffix = crypto.randomUUID();
      const { organization: zeta } = await insertOrganization(transaction, {
        name: `Zeta ${suffix}`,
        adminUserId: user.id,
      });
      const { organization: alpha } = await insertOrganization(transaction, {
        name: `Alpha ${suffix}`,
        adminUserId: user.id,
      });
      // An admin, but alongside another.
      const { organization: shared } = await insertOrganization(transaction, {
        adminUserId: user.id,
      });
      await insertOrganizationMember(transaction, { organizationId: shared.id, role: 'admin' });
      // A member, under someone else's admin.
      const { organization: joined } = await insertOrganization(transaction);
      await insertOrganizationMember(transaction, {
        organizationId: joined.id,
        userId: user.id,
      });

      expect(await _loadSoleAdminOrganizations(transaction, user.id)).toEqual([
        { slug: alpha.slug, name: alpha.name },
        { slug: zeta.slug, name: zeta.name },
      ]);
    });
  });

  test('a user in no organization has none', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUser(transaction);

      expect(await _loadSoleAdminOrganizations(transaction, user.id)).toEqual([]);
    });
  });
});
