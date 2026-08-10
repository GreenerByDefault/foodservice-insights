import type { DatabaseExecutor, OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, test } from 'vitest';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { database } from './db.ts';
import { resolveOrganization, switchableOrganizations } from './organizations.ts';

/** Touching this fails the test, which is how the no-query path for a member is asserted. */
const NO_DATABASE = undefined as unknown as DatabaseExecutor;

const ORGANIZATION_ID = crypto.randomUUID() as OrganizationId;

function memberOf(name: string) {
  return anAuthContext({
    memberships: [{ organizationId: ORGANIZATION_ID, organizationName: name, role: 'member' }],
  });
}

async function statusOf(call: () => Promise<unknown>): Promise<number> {
  try {
    await call();
  } catch (thrown) {
    if (isHttpError(thrown)) return thrown.status;
    throw thrown;
  }
  throw new Error('Expected a 404, but the call returned.');
}

describe('resolveOrganization', () => {
  test('answers a member from their membership alone', async () => {
    const auth = memberOf('Acme Foods');

    await expect(resolveOrganization(NO_DATABASE, auth, ORGANIZATION_ID)).resolves.toEqual({
      organization: { id: ORGANIZATION_ID, name: 'Acme Foods' },
      role: 'member',
    });
  });

  test('404s someone with no membership', async () => {
    expect(
      await statusOf(() => resolveOrganization(NO_DATABASE, anAuthContext(), ORGANIZATION_ID)),
    ).toBe(404);
  });

  test('reads the organization for a superadmin, who has no membership row', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const superadmin = anAuthContext({ user: { isSuperadmin: true } });

      await expect(resolveOrganization(transaction, superadmin, organization.id)).resolves.toEqual({
        organization: { id: organization.id, name: organization.name },
        role: 'admin',
      });
    });
  });

  test('404s a superadmin on an id no organization has', async () => {
    await withRollback(database(), async (transaction) => {
      const superadmin = anAuthContext({ user: { isSuperadmin: true } });

      expect(
        await statusOf(() => resolveOrganization(transaction, superadmin, ORGANIZATION_ID)),
      ).toBe(404);
    });
  });
});

describe('switchableOrganizations', () => {
  test('offers a member their own, without a query', async () => {
    const auth = memberOf('Acme Foods');

    await expect(switchableOrganizations(NO_DATABASE, auth)).resolves.toEqual([
      { id: ORGANIZATION_ID, name: 'Acme Foods' },
    ]);
  });

  test('offers a superadmin one they do not belong to', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const superadmin = anAuthContext({ user: { isSuperadmin: true } });

      const offered = await switchableOrganizations(transaction, superadmin);

      expect(offered).toContainEqual({ id: organization.id, name: organization.name });
    });
  });
});
