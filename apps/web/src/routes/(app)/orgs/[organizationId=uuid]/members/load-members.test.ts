import type { UserId } from '@gbd/db';
import {
  insertAppUser,
  insertOrganization,
  insertOrganizationMember,
  withRollback,
} from '@gbd/db/testing';
import { expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { _loadMembers } from './+page.server.ts';

test('lists admins before members, then by email, and marks the viewer’s own row', async () => {
  await withRollback(database(), async (transaction) => {
    const { organization } = await insertOrganization(transaction, {
      name: `Members test ${crypto.randomUUID()}`,
    });
    const member = await insertAppUser(transaction, {
      displayName: 'Ana Ruiz',
      email: 'ana@example.test',
    });
    await insertOrganizationMember(transaction, {
      organizationId: organization.id,
      userId: member.id,
      role: 'member',
    });

    const rows = await _loadMembers(transaction, {
      organizationId: organization.id,
      viewerId: member.id,
    });

    expect(rows).toEqual([
      { displayName: null, email: expect.any(String), role: 'admin', isYou: false },
      { displayName: 'Ana Ruiz', email: 'ana@example.test', role: 'member', isYou: true },
    ]);
    expect(rows[0]?.email).not.toBe('ana@example.test');
  });
});

test('shows email only, with no name, for a member with no display name', async () => {
  await withRollback(database(), async (transaction) => {
    const { organization } = await insertOrganization(transaction, {
      name: `Members test ${crypto.randomUUID()}`,
    });
    const member = await insertAppUser(transaction, { email: 'no-name@example.test' });
    await insertOrganizationMember(transaction, {
      organizationId: organization.id,
      userId: member.id,
      role: 'member',
    });

    const rows = await _loadMembers(transaction, {
      organizationId: organization.id,
      viewerId: crypto.randomUUID() as UserId,
    });

    expect(rows).toContainEqual({
      displayName: null,
      email: 'no-name@example.test',
      role: 'member',
      isYou: false,
    });
  });
});

test('omits a superadmin, who has access but holds no organization_member row', async () => {
  await withRollback(database(), async (transaction) => {
    const { organization, admin } = await insertOrganization(transaction, {
      name: `Members test ${crypto.randomUUID()}`,
    });
    await insertAppUser(transaction, { isSuperadmin: true });

    const rows = await _loadMembers(transaction, {
      organizationId: organization.id,
      viewerId: admin.id,
    });

    expect(rows).toEqual([
      { displayName: null, email: expect.any(String), role: 'admin', isYou: true },
    ]);
  });
});
