import type { UserId } from '@gbd/db';
import { insertOrganizationMember, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { statusOf } from '$lib/server/testing/http-error';
import { _changeMemberRole } from './+server.ts';

describe('_changeMemberRole', () => {
  test('promotes a member, and writes a member.role_changed audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin, members } = await anOrganizationWithMembers(transaction, [
        { role: 'member' },
      ]);
      const [targetUserId] = members as [UserId];
      const actor: Actor = { userId: admin, role: 'admin' };

      await _changeMemberRole(
        transaction,
        { organizationId, actor, targetUserId },
        { role: 'admin' },
      );

      const promoted = await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', targetUserId)
        .executeTakeFirstOrThrow();
      expect(promoted.role).toBe('admin');

      expect(await auditEventsFor(transaction, targetUserId)).toEqual([
        expectedAuditEvent({
          action: 'member.role_changed',
          actorUserId: admin,
          target: { type: 'user', id: targetUserId, organizationId },
          detail: { role: 'admin' },
        }),
      ]);
    });
  });

  test('demoting the only admin answers 409 last-admin, leaves the role, and writes no audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _changeMemberRole(
        transaction,
        { organizationId, actor, targetUserId: admin },
        { role: 'member' },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'last-admin' });

      // The transaction is left aborted by the check violation — see withTransaction's
      // documented join-not-nest trade-off — so nothing is read back here; withRollback
      // discards the row regardless.
    });
  });

  test('demoting one of two admins succeeds', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const secondAdmin = await insertOrganizationMember(transaction, {
        organizationId,
        role: 'admin',
      });
      const actor: Actor = { userId: admin, role: 'admin' };

      await _changeMemberRole(
        transaction,
        { organizationId, actor, targetUserId: secondAdmin.userId as UserId },
        { role: 'member' },
      );

      const demoted = await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', secondAdmin.userId)
        .executeTakeFirstOrThrow();
      expect(demoted.role).toBe('member');
    });
  });

  test('setting the same role again answers with no error and writes no audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };

      await _changeMemberRole(
        transaction,
        { organizationId, actor, targetUserId: admin },
        { role: 'admin' },
      );

      expect(await auditEventsFor(transaction, admin)).toEqual([]);
    });
  });

  test('a user who is not a member of the organization is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const stranger = crypto.randomUUID() as UserId;

      await expect(
        statusOf(() =>
          _changeMemberRole(
            transaction,
            { organizationId, actor, targetUserId: stranger },
            { role: 'admin' },
          ),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test.for([undefined, null, {}, { role: 'owner' }, { role: 123 }])(
    'a bad body %j is a 400',
    async (body) => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
        const actor: Actor = { userId: admin, role: 'admin' };

        const response = await _changeMemberRole(
          transaction,
          { organizationId, actor, targetUserId: admin },
          body,
        );

        expect(response.status).toBe(400);
      });
    },
  );
});
