import type { UserId } from '@gbd/db';
import { withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { _loadMembers } from './+page.server.ts';

describe('_loadMembers', () => {
  test('lists admins before members, then by email, and marks the viewer’s own row', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin, members } = await anOrganizationWithMembers(transaction, [
        { role: 'member', displayName: 'Ana Ruiz', email: 'ana@example.test' },
      ]);
      const [ana] = members;

      const rows = await _loadMembers(transaction, { organizationId, viewerId: ana as UserId });

      expect(rows).toEqual([
        {
          userId: admin,
          displayName: null,
          email: expect.any(String),
          role: 'admin',
          isYou: false,
        },
        {
          userId: ana,
          displayName: 'Ana Ruiz',
          email: 'ana@example.test',
          role: 'member',
          isYou: true,
        },
      ]);
      expect(rows[0]?.email).not.toBe('ana@example.test');
    });
  });

  test('returns a null displayName rather than substituting the email', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, members } = await anOrganizationWithMembers(transaction, [
        { role: 'member', email: 'no-name@example.test' },
      ]);
      const [noName] = members;

      const rows = await _loadMembers(transaction, {
        organizationId,
        viewerId: crypto.randomUUID() as UserId,
      });

      expect(rows).toContainEqual({
        userId: noName,
        displayName: null,
        email: 'no-name@example.test',
        role: 'member',
        isYou: false,
      });
    });
  });
});
