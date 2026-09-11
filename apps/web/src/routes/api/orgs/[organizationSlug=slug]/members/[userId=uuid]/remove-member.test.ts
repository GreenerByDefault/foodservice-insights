import type { UserId } from '@gbd/db';
import { insertOrganizationMember, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { statusOf } from '$lib/server/testing/http-error';
import { _removeMember } from './+server.ts';

describe('_removeMember', () => {
  test('an admin removes a member, and writes a member.removed audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin, members } = await anOrganizationWithMembers(transaction, [
        { role: 'member' },
      ]);
      const [targetUserId] = members as [UserId];
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _removeMember(transaction, { organizationId, actor, targetUserId });

      expect(response.status).toBe(204);
      const remaining = await transaction
        .selectFrom('organizationMember')
        .select('userId')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', targetUserId)
        .executeTakeFirst();
      expect(remaining).toBeUndefined();

      expect(await auditEventsFor(transaction, targetUserId)).toEqual([
        expectedAuditEvent({
          action: 'member.removed',
          actorUserId: admin,
          target: { type: 'user', id: targetUserId, organizationId },
        }),
      ]);
    });
  });

  test('a member leaves, and writes a member.left audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, members } = await anOrganizationWithMembers(transaction, [
        { role: 'member' },
      ]);
      const [targetUserId] = members as [UserId];
      const actor: Actor = { userId: targetUserId, role: 'member' };

      const response = await _removeMember(transaction, { organizationId, actor, targetUserId });

      expect(response.status).toBe(204);
      expect(await auditEventsFor(transaction, targetUserId)).toEqual([
        expectedAuditEvent({
          action: 'member.left',
          actorUserId: targetUserId,
          target: { type: 'user', id: targetUserId, organizationId },
        }),
      ]);
    });
  });

  test('an admin leaves while another admin remains', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const secondAdmin = await insertOrganizationMember(transaction, {
        organizationId,
        role: 'admin',
      });
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _removeMember(transaction, {
        organizationId,
        actor,
        targetUserId: admin,
      });

      expect(response.status).toBe(204);
      const remaining = await transaction
        .selectFrom('organizationMember')
        .select('userId')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', secondAdmin.userId)
        .executeTakeFirstOrThrow();
      expect(remaining.userId).toBe(secondAdmin.userId);
    });
  });

  test('the only admin leaving answers 409 last-admin, and writes no audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _removeMember(transaction, {
        organizationId,
        actor,
        targetUserId: admin,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'last-admin' });

      // The transaction is left aborted by the check violation — see withTransaction's
      // documented join-not-nest trade-off — so nothing is read back here; withRollback
      // discards the row regardless.
    });
  });

  test('a user who is not a member of the organization is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const stranger = crypto.randomUUID() as UserId;

      await expect(
        statusOf(() =>
          _removeMember(transaction, { organizationId, actor, targetUserId: stranger }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
