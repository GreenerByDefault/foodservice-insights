import type { OrganizationInviteId } from '@gbd/db';
import {
  dbMsAgo,
  insertOrganization,
  insertOrganizationInvite,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { statusOf } from '$lib/server/testing/http-error';
import { lockInviteForEmailOrNotFound } from './claim.ts';

describe('lockInviteForEmailOrNotFound', () => {
  test('returns the pending invite matching id and email', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'invitee@example.test',
      });

      const found = await lockInviteForEmailOrNotFound(
        transaction,
        invite.id,
        'invitee@example.test',
      );

      expect(found).toMatchObject({ id: invite.id, email: 'invitee@example.test' });
      expect(found.isExpired).toBe(false);
    });
  });

  test('matches the email case-insensitively', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'invitee@example.test',
      });

      const found = await lockInviteForEmailOrNotFound(
        transaction,
        invite.id,
        'Invitee@Example.Test',
      );

      expect(found.id).toBe(invite.id);
    });
  });

  test('reports an invite past its expiry as expired', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'invitee@example.test',
        expiresAt: dbMsAgo(1000),
      });

      const found = await lockInviteForEmailOrNotFound(
        transaction,
        invite.id,
        'invitee@example.test',
      );

      expect(found.isExpired).toBe(true);
    });
  });

  test('an invite belonging to another address is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'invitee@example.test',
      });

      await expect(
        statusOf(() =>
          lockInviteForEmailOrNotFound(transaction, invite.id, 'someone-else@example.test'),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('an id that matches no invite at all is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'invitee@example.test',
      });

      await expect(
        statusOf(() =>
          lockInviteForEmailOrNotFound(
            transaction,
            crypto.randomUUID() as OrganizationInviteId,
            'invitee@example.test',
          ),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
