import type { OrganizationId } from '@gbd/db';
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, test } from 'vitest';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { requireAuth, requireMembership, requireOrganizationAdmin } from './guards.ts';
import type { AuthContext } from './types.ts';

const ORGANIZATION_ID = crypto.randomUUID() as OrganizationId;

/** The status and code SvelteKit would send, or a failure if the call did not throw at all. */
function statusOf(call: () => unknown): { status: number; code?: string } {
  try {
    call();
  } catch (thrown) {
    if (isHttpError(thrown)) return { status: thrown.status, code: thrown.body.code };
    throw thrown;
  }
  throw new Error('Expected the guard to throw, but it returned.');
}

function memberOf(role: 'member' | 'admin'): AuthContext {
  return anAuthContext({
    memberships: [{ organizationId: ORGANIZATION_ID, organizationName: 'Acme Foods', role }],
  });
}

describe('requireAuth', () => {
  test('returns the context that is there', () => {
    const auth = anAuthContext();

    expect(requireAuth({ auth })).toBe(auth);
  });

  test('401s when there is none', () => {
    expect(statusOf(() => requireAuth({ auth: null }))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('requireMembership', () => {
  test('returns the role', () => {
    expect(requireMembership(memberOf('member'), ORGANIZATION_ID)).toBe('member');
  });

  // 403 would tell an outsider the organization exists.
  test('404s a non-member rather than 403ing them', () => {
    expect(statusOf(() => requireMembership(anAuthContext(), ORGANIZATION_ID))).toEqual({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('requireOrganizationAdmin', () => {
  test('lets an admin through', () => {
    expect(() => requireOrganizationAdmin(memberOf('admin'), ORGANIZATION_ID)).not.toThrow();
  });

  test('lets a superadmin through without a membership', () => {
    const superadmin = anAuthContext({ user: { isSuperadmin: true } });

    expect(() => requireOrganizationAdmin(superadmin, ORGANIZATION_ID)).not.toThrow();
  });

  // A member already knows the organization exists, so 403 leaks nothing here.
  test('403s a plain member', () => {
    expect(statusOf(() => requireOrganizationAdmin(memberOf('member'), ORGANIZATION_ID))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  test('404s an outsider', () => {
    expect(statusOf(() => requireOrganizationAdmin(anAuthContext(), ORGANIZATION_ID))).toEqual({
      status: 404,
      code: 'not_found',
    });
  });
});
