import type { OrganizationInviteId } from '@gbd/db';
import {
  dbMsAgo,
  insertAppUserWithEmail,
  insertOrganization,
  insertOrganizationInvite,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { statusOf } from '$lib/server/testing/http-error';
import { _declineInvite } from './+server.ts';

describe('_declineInvite', () => {
  test('marks a pending invite declined and records invite.declined', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
      });

      const response = await _declineInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(204);

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('declined');

      expect(await auditEventsFor(transaction, invite.id)).toEqual([
        expectedAuditEvent({
          action: 'invite.declined',
          actorUserId: user.id,
          target: { type: 'invite', id: invite.id, organizationId: organization.id },
        }),
      ]);
    });
  });

  test('an invite past its expiry is dismissed as expired, not declined', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
        expiresAt: dbMsAgo(1000),
      });

      const response = await _declineInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(204);

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('expired');

      expect(await auditEventsFor(transaction, invite.id)).toEqual([
        expectedAuditEvent({
          action: 'invite.expired',
          actorUserId: user.id,
          target: { type: 'invite', id: invite.id, organizationId: organization.id },
        }),
      ]);
    });
  });

  test('an invite that is not pending answers 409 and writes nothing', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
        status: 'accepted',
      });

      const response = await _declineInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'no-longer-valid' });

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('accepted');
      expect(await auditEventsFor(transaction, invite.id)).toEqual([]);
    });
  });

  test("another user's invite is a 404", async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invitee = await insertAppUserWithEmail(transaction);
      const someoneElse = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: invitee.email,
      });

      await expect(
        statusOf(() => _declineInvite(transaction, { inviteId: invite.id, user: someoneElse })),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('an id that matches no invite at all is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);

      await expect(
        statusOf(() =>
          _declineInvite(transaction, {
            inviteId: crypto.randomUUID() as OrganizationInviteId,
            user,
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
