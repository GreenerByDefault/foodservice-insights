import type { Database, OrganizationId, UserId } from '@gbd/db';
import { insertOrganizationMember, withRollback } from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { statusOf } from '$lib/server/testing/http-error';
import { _removeMember } from './+server.ts';

/** An organization and its sole admin, acting as themselves — the preamble every situation below
 * that doesn't need a second member starts from. */
async function anAdminOrg(
  transaction: Transaction<Database>,
): Promise<{ organizationId: OrganizationId; admin: UserId; actor: Actor }> {
  const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
  return { organizationId, admin, actor: { userId: admin, role: 'admin' } };
}

describe('_removeMember', () => {
  describe('an admin removing another member', () => {
    test('removes them, and writes a member.removed audit event', async () => {
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
  });

  describe('a member leaving', () => {
    test('writes a member.left audit event', async () => {
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
  });

  describe('an admin leaving while another admin remains', () => {
    test('succeeds', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin, actor } = await anAdminOrg(transaction);
        const secondAdmin = await insertOrganizationMember(transaction, {
          organizationId,
          role: 'admin',
        });

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
  });

  describe('the only admin leaving', () => {
    test('answers 409 last-admin, and writes no audit event', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin, actor } = await anAdminOrg(transaction);

        const response = await _removeMember(transaction, {
          organizationId,
          actor,
          targetUserId: admin,
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'last-admin' });

        // Nothing is read back here — see withTransaction's documented join-not-nest trade-off.
      });
    });
  });

  describe('a user who is not a member of the organization', () => {
    test('is a 404', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, actor } = await anAdminOrg(transaction);
        const stranger = crypto.randomUUID() as UserId;

        await expect(
          statusOf(() =>
            _removeMember(transaction, { organizationId, actor, targetUserId: stranger }),
          ),
        ).resolves.toEqual({ status: 404, code: 'not_found' });
      });
    });
  });
});
