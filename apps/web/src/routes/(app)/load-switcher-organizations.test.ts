import type { OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { expect, test } from 'vitest';
import type { OrganizationAccess } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { _loadSwitcherOrganizations, _SWITCHER_LIMIT } from './+layout.server.ts';

function membershipTo(name: string): OrganizationAccess {
  return {
    organizationId: crypto.randomUUID() as OrganizationId,
    organizationName: name,
    role: 'member',
  };
}

function paddedNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Org ${String(i).padStart(2, '0')}`);
}

/** Digit-prefixed and unique per call, so these sort ahead of every other organization the shared
 * test database holds — the seed's placeholder org and whatever concurrent fixtures have
 * committed for real, both of which are ordinary, letter-led names. That lets a query against the
 * live, unscoped `organization` table assert on an exact prefix rather than the whole table. */
function paddedNamesSortingFirst(count: number): string[] {
  const prefix = `0-${crypto.randomUUID()}`;
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
}

test('a member under the cap sees every organization they belong to, unsliced', async () => {
  const memberships = paddedNames(3).map(membershipTo);
  const auth = anAuthContext({ memberships });

  const organizations = await _loadSwitcherOrganizations(database(), auth);

  expect(organizations).toEqual(
    memberships.map(({ organizationId, organizationName }) => ({
      id: organizationId,
      name: organizationName,
    })),
  );
});

test('a member of more than _SWITCHER_LIMIT organizations is truncated at exactly the cap', async () => {
  const memberships = paddedNames(_SWITCHER_LIMIT + 3).map(membershipTo);
  const auth = anAuthContext({ memberships });

  const organizations = await _loadSwitcherOrganizations(database(), auth);

  expect(organizations).toEqual(
    memberships.slice(0, _SWITCHER_LIMIT).map(({ organizationId, organizationName }) => ({
      id: organizationId,
      name: organizationName,
    })),
  );
});

test('a superadmin sees the organization table itself, alphabetically, limited to the cap', async () => {
  await withRollback(database(), async (transaction) => {
    const names = paddedNamesSortingFirst(_SWITCHER_LIMIT + 2);
    for (const name of names) await insertOrganization(transaction, { name });
    const auth = anAuthContext({ user: { isSuperadmin: true } });

    const organizations = await _loadSwitcherOrganizations(transaction, auth);

    // These sort ahead of everything else in the table (see `paddedNamesSortingFirst`), so the
    // capped result is exactly our own first _SWITCHER_LIMIT — not "some _SWITCHER_LIMIT rows".
    expect(organizations.map((organization) => organization.name)).toEqual(
      names.slice(0, _SWITCHER_LIMIT),
    );
  });
});
