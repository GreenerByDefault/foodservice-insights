import type { OrganizationId } from '@gbd/db';
import { insertAppUser, insertOrganization, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { statusOf } from '$lib/server/tests/http-error';
import { requireAuth, requireOrganizationAccess, requireOrganizationAdmin } from './guards.ts';
import type { AuthContext } from './types.ts';

const ORGANIZATION_ID = crypto.randomUUID() as OrganizationId;

function withRoleIn(role: 'member' | 'admin'): AuthContext {
  return anAuthContext({
    memberships: [{ organizationId: ORGANIZATION_ID, organizationName: 'Acme Foods', role }],
  });
}

describe('requireAuth', () => {
  test('returns the context that is there', () => {
    const auth = anAuthContext();

    expect(requireAuth({ auth })).toBe(auth);
  });

  test('401s when there is none', async () => {
    await expect(statusOf(() => requireAuth({ auth: null }))).resolves.toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('requireOrganizationAccess', () => {
  test('returns the access a membership row grants', async () => {
    await expect(
      requireOrganizationAccess(database(), withRoleIn('member'), ORGANIZATION_ID),
    ).resolves.toEqual({
      organizationId: ORGANIZATION_ID,
      organizationName: 'Acme Foods',
      role: 'member',
    });
  });

  test('404s a non-superadmin with no membership, rather than 403ing them', async () => {
    await expect(
      statusOf(() => requireOrganizationAccess(database(), anAuthContext(), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 404, code: 'not_found' });
  });

  test('a superadmin with no membership is admin anyway', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction, { name: 'Acme Foods' });
      const superadmin = await insertAppUser(transaction, { isSuperadmin: true });
      const auth = anAuthContext({ user: { id: superadmin.id, isSuperadmin: true } });

      await expect(requireOrganizationAccess(transaction, auth, organization.id)).resolves.toEqual({
        organizationId: organization.id,
        organizationName: 'Acme Foods',
        role: 'admin',
      });
    });
  });

  // The demotion trap: a superadmin who created an organization holds a genuine `member` row
  // there (`organization_check_has_member`), and that row must not shadow the superadmin flag.
  test("a superadmin holding a member row is still admin, not the row's own role", async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction, { name: 'Acme Foods' });
      await transaction
        .updateTable('appUser')
        .set({ isSuperadmin: true })
        .where('id', '=', admin.id)
        .execute();
      const auth = anAuthContext({
        user: { id: admin.id, isSuperadmin: true },
        memberships: [
          { organizationId: organization.id, organizationName: 'Acme Foods', role: 'admin' },
        ],
      });

      await expect(requireOrganizationAccess(transaction, auth, organization.id)).resolves.toEqual({
        organizationId: organization.id,
        organizationName: 'Acme Foods',
        role: 'admin',
      });
    });
  });

  test('404s a superadmin on an organization id that does not exist', async () => {
    await withRollback(database(), async (transaction) => {
      const auth = anAuthContext({ user: { isSuperadmin: true } });

      await expect(
        statusOf(() => requireOrganizationAccess(transaction, auth, ORGANIZATION_ID)),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});

describe('requireOrganizationAdmin', () => {
  test('lets an admin through', async () => {
    await expect(
      requireOrganizationAdmin(database(), withRoleIn('admin'), ORGANIZATION_ID),
    ).resolves.toBeUndefined();
  });

  test('403s a plain member', async () => {
    await expect(
      statusOf(() => requireOrganizationAdmin(database(), withRoleIn('member'), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 403, code: 'forbidden' });
  });

  test('404s an outsider', async () => {
    await expect(
      statusOf(() => requireOrganizationAdmin(database(), anAuthContext(), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 404, code: 'not_found' });
  });
});
