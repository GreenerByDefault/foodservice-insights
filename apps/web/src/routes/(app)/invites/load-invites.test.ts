import {
  DB_NOW,
  dbMsAgo,
  insertAppUser,
  insertOrganization,
  insertOrganizationInvite,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { anEmail } from '$lib/server/testing/fixtures';
import { _loadInvites } from './+page.server.ts';

describe('_loadInvites', () => {
  test("lists the address's pending invites newest first, matching it case-insensitively", async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const inviter = await insertAppUser(transaction, { displayName: 'Priya Shah' });
      const { organization: olderOrganization } = await insertOrganization(transaction);
      const { organization: newerOrganization } = await insertOrganization(transaction);
      const older = await insertOrganizationInvite(transaction, {
        organizationId: olderOrganization.id,
        email,
        role: 'member',
        invitedByUserId: inviter.id,
        createdAt: dbMsAgo(1000),
      });
      const newer = await insertOrganizationInvite(transaction, {
        organizationId: newerOrganization.id,
        email,
        role: 'admin',
        invitedByUserId: inviter.id,
        createdAt: DB_NOW,
      });

      const offers = await _loadInvites(transaction, email.toUpperCase());

      expect(offers).toEqual([
        {
          inviteId: newer.id,
          organizationName: newerOrganization.name,
          role: 'admin',
          invitedByName: 'Priya Shah',
          expiresAt: newer.expiresAt,
          isExpired: false,
          now: expect.any(Date),
        },
        {
          inviteId: older.id,
          organizationName: olderOrganization.name,
          role: 'member',
          invitedByName: 'Priya Shah',
          expiresAt: older.expiresAt,
          isExpired: false,
          now: expect.any(Date),
        },
      ]);
    });
  });

  test('an inviter with no display name, or none at all, is null', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const unnamed = await insertAppUser(transaction);
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        invitedByUserId: unnamed.id,
      });
      const { organization: other } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: other.id,
        email,
        invitedByUserId: null,
      });

      const offers = await _loadInvites(transaction, email);

      expect(offers.map((offer) => offer.invitedByName)).toEqual([null, null]);
    });
  });

  test('a pending invite past its deadline is listed, marked expired', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      const expired = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: new Date(Date.now() - 1000),
      });

      const offers = await _loadInvites(transaction, email);

      expect(offers).toEqual([
        {
          inviteId: expired.id,
          organizationName: organization.name,
          role: 'member',
          invitedByName: null,
          expiresAt: expired.expiresAt,
          isExpired: true,
          now: expect.any(Date),
        },
      ]);
    });
  });

  test('invites no longer pending, or for another address, are never listed', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      for (const status of ['accepted', 'declined', 'expired', 'revoked', 'superseded'] as const) {
        await insertOrganizationInvite(transaction, {
          organizationId: organization.id,
          email,
          status,
        });
      }
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: anEmail(),
      });

      expect(await _loadInvites(transaction, email)).toEqual([]);
    });
  });
});
