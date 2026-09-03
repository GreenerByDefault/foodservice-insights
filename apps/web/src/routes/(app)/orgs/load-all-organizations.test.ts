import type { OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { expect, test } from 'vitest';
import type { OrganizationAccess } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { _loadAllOrganizations } from './+page.server.ts';

function membershipTo(name: string): OrganizationAccess {
  return {
    organizationId: crypto.randomUUID() as OrganizationId,
    organizationName: name,
    role: 'member',
  };
}

test('a non-superadmin gets their own memberships, not the organization table', async () => {
  const memberships = [membershipTo('Zenith Dining'), membershipTo('Acme Foods')];
  const auth = anAuthContext({ memberships });

  // No database passed: a query here would throw, not just fail an assertion.
  const result = await _loadAllOrganizations(undefined as never, auth);

  expect(result).toEqual(
    memberships.map(({ organizationId, organizationName }) => ({
      id: organizationId,
      name: organizationName,
    })),
  );
});

test('a superadmin gets the whole organization table, alphabetically — not just their memberships', async () => {
  await withRollback(database(), async (transaction) => {
    // Unique per run, so filtering the live table down to these is exact regardless of whatever
    // else the shared test database holds.
    const prefix = `Switcher test org ${crypto.randomUUID()}`;
    const names = [`${prefix} B`, `${prefix} A`, `${prefix} C`];
    for (const name of names) await insertOrganization(transaction, { name });
    const auth = anAuthContext({
      user: { isSuperadmin: true },
      memberships: [membershipTo('Not the customer list')],
    });

    const result = await _loadAllOrganizations(transaction, auth);

    expect(result.filter((organization) => organization.name.startsWith(prefix))).toEqual(
      [...names].sort().map((name) => ({ id: expect.any(String), name })),
    );
  });
});
