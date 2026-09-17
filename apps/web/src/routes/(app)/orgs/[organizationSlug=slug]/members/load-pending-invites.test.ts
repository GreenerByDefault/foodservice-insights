import { insertOrganizationInvite, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { _loadPendingInvites } from './+page.server.ts';

describe('_loadPendingInvites', () => {
  test('lists pending invites newest first', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId } = await anOrganizationWithMembers(transaction, []);
      const older = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'older@example.test',
        role: 'member',
      });
      const newer = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'newer@example.test',
        role: 'admin',
      });

      const rows = await _loadPendingInvites(transaction, { organizationId });

      expect(rows).toEqual([
        {
          inviteId: newer.id,
          email: 'newer@example.test',
          role: 'admin',
          expiresAt: newer.expiresAt,
          isExpired: false,
          now: expect.any(Date),
        },
        {
          inviteId: older.id,
          email: 'older@example.test',
          role: 'member',
          expiresAt: older.expiresAt,
          isExpired: false,
          now: expect.any(Date),
        },
      ]);
    });
  });

  test('a pending invite past its deadline is shown, marked expired', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId } = await anOrganizationWithMembers(transaction, []);
      const expired = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'expired@example.test',
        expiresAt: new Date(Date.now() - 1000),
      });

      const rows = await _loadPendingInvites(transaction, { organizationId });

      expect(rows).toEqual([
        {
          inviteId: expired.id,
          email: 'expired@example.test',
          role: 'member',
          expiresAt: expired.expiresAt,
          isExpired: true,
          now: expect.any(Date),
        },
      ]);
    });
  });

  test('superseded and revoked invites are never shown', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId } = await anOrganizationWithMembers(transaction, []);
      await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'superseded@example.test',
        status: 'superseded',
      });
      await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'revoked@example.test',
        status: 'revoked',
      });

      const rows = await _loadPendingInvites(transaction, { organizationId });

      expect(rows).toEqual([]);
    });
  });
});
