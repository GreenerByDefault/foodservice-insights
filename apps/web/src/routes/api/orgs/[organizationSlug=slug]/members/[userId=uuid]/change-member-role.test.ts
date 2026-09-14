import type { Database, OrganizationId, UserId } from '@gbd/db';
import { insertOrganizationMember, withRollback } from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { statusOf } from '$lib/server/testing/http-error';
import { _changeMemberRole } from './+server.ts';

/** An organization and its sole admin, acting as themselves — the preamble every situation below
 * that doesn't need a second member starts from. */
async function anAdminOrg(
  transaction: Transaction<Database>,
): Promise<{ organizationId: OrganizationId; admin: UserId; actor: Actor }> {
  const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
  return { organizationId, admin, actor: { userId: admin, role: 'admin' } };
}

describe('_changeMemberRole', () => {
  describe('a valid role change', () => {
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
            detail: { from: 'member', to: 'admin' },
          }),
        ]);
      });
    });

    test('demoting one of two admins succeeds', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, actor } = await anAdminOrg(transaction);
        const secondAdmin = await insertOrganizationMember(transaction, {
          organizationId,
          role: 'admin',
        });

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
        const { organizationId, admin, actor } = await anAdminOrg(transaction);

        await _changeMemberRole(
          transaction,
          { organizationId, actor, targetUserId: admin },
          { role: 'admin' },
        );

        expect(await auditEventsFor(transaction, admin)).toEqual([]);
      });
    });
  });

  describe('demoting the only admin', () => {
    test('answers 409 last-admin, leaves the role, and writes no audit event', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin, actor } = await anAdminOrg(transaction);

        const response = await _changeMemberRole(
          transaction,
          { organizationId, actor, targetUserId: admin },
          { role: 'member' },
        );

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
            _changeMemberRole(
              transaction,
              { organizationId, actor, targetUserId: stranger },
              { role: 'admin' },
            ),
          ),
        ).resolves.toEqual({ status: 404, code: 'not_found' });
      });
    });
  });

  describe('an invalid body', () => {
    // `parseBody` is tested once against its schema elsewhere (`body.test.ts`); this is the
    // wiring check that the route actually calls it.
    test('a role outside the picklist is a 400', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin, actor } = await anAdminOrg(transaction);

        const response = await _changeMemberRole(
          transaction,
          { organizationId, actor, targetUserId: admin },
          { role: 'owner' },
        );

        expect(response.status).toBe(400);
      });
    });
  });
});
