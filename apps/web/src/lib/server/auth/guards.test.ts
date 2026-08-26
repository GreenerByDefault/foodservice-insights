import type { OrganizationId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { statusOf } from '$lib/server/tests/http-error';
import { requireAuth, requireOrganizationAccess, requireOrganizationAdmin } from './guards.ts';
import type { AuthContext } from './types.ts';

const ORGANIZATION_ID = crypto.randomUUID() as OrganizationId;

function withRoleIn(role: 'member' | 'admin'): AuthContext {
  return anAuthContext({
    organizations: [{ organizationId: ORGANIZATION_ID, organizationName: 'Acme Foods', role }],
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
  test('returns the access', () => {
    expect(requireOrganizationAccess(withRoleIn('member'), ORGANIZATION_ID)).toEqual({
      organizationId: ORGANIZATION_ID,
      organizationName: 'Acme Foods',
      role: 'member',
    });
  });

  test('404s someone with no access rather than 403ing them', async () => {
    await expect(
      statusOf(() => requireOrganizationAccess(anAuthContext(), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 404, code: 'not_found' });
  });
});

describe('requireOrganizationAdmin', () => {
  test('lets an admin through', () => {
    expect(() => requireOrganizationAdmin(withRoleIn('admin'), ORGANIZATION_ID)).not.toThrow();
  });

  test('403s a plain member', async () => {
    await expect(
      statusOf(() => requireOrganizationAdmin(withRoleIn('member'), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 403, code: 'forbidden' });
  });

  test('404s an outsider', async () => {
    await expect(
      statusOf(() => requireOrganizationAdmin(anAuthContext(), ORGANIZATION_ID)),
    ).resolves.toEqual({ status: 404, code: 'not_found' });
  });
});
