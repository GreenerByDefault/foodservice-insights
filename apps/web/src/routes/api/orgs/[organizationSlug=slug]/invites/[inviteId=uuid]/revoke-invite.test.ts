import type { OrganizationInviteId } from '@gbd/db';
import { insertOrganizationInvite, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { statusOf } from '$lib/server/testing/http-error';
import { _revokeInvite } from './+server.ts';

describe('_revokeInvite', () => {
  test('revokes a pending invite and records invite.revoked', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const invite = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'invitee@example.test',
        invitedByUserId: admin,
      });

      const response = await _revokeInvite(transaction, {
        organizationId,
        actor,
        inviteId: invite.id,
      });

      expect(response.status).toBe(204);
      const revoked = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(revoked.status).toBe('revoked');

      expect(await auditEventsFor(transaction, invite.id)).toEqual([
        expectedAuditEvent({
          action: 'invite.revoked',
          actorUserId: admin,
          target: { type: 'invite', id: invite.id, organizationId },
        }),
      ]);
    });
  });

  test('an invite that is not pending is a 404, and its status is unchanged', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const invite = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'invitee@example.test',
        invitedByUserId: admin,
        status: 'accepted',
      });

      await expect(
        statusOf(() => _revokeInvite(transaction, { organizationId, actor, inviteId: invite.id })),
      ).resolves.toEqual({ status: 404, code: 'not_found' });

      const unchanged = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(unchanged.status).toBe('accepted');
      expect(await auditEventsFor(transaction, invite.id)).toEqual([]);
    });
  });

  test('an invite id that does not belong to the organization is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const other = await anOrganizationWithMembers(transaction, []);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: other.organizationId,
        email: 'invitee@example.test',
        invitedByUserId: other.admin,
      });

      await expect(
        statusOf(() => _revokeInvite(transaction, { organizationId, actor, inviteId: invite.id })),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('an id that matches no invite at all is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const inviteId = crypto.randomUUID() as OrganizationInviteId;

      await expect(
        statusOf(() => _revokeInvite(transaction, { organizationId, actor, inviteId })),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
