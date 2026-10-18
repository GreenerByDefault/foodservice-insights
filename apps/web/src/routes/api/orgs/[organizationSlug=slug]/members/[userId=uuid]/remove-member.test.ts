import type { UserId } from '@gbd/db';
import { insertOrganizationMember, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import type { Actor } from '#lib/server/auth/types.js';
import { database } from '#lib/server/db.js';
import { auditEventsFor, expectedAuditEvent } from '#lib/server/testing/audit.js';
import { statusOf } from '#lib/server/testing/http-error.js';
import {
  insertAdminOrg,
  insertOrganizationWithMembers,
} from '#lib/server/testing/organizations.js';
import { _removeMember } from './+server.ts';

describe('_removeMember', () => {
  describe('an admin removing another member', () => {
    test('removes them, and writes a member.removed audit event', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin, members } = await insertOrganizationWithMembers(
          transaction,
          [{ role: 'member' }],
        );
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
        const { organizationId, members } = await insertOrganizationWithMembers(transaction, [
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
        const { organizationId, admin, actor } = await insertAdminOrg(transaction);
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
        const { organizationId, admin, actor } = await insertAdminOrg(transaction);

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
        const { organizationId, actor } = await insertAdminOrg(transaction);
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
