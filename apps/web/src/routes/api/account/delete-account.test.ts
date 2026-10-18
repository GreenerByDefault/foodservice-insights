import type { Database, OrganizationId, OrganizationInviteStatus, UserId } from '@gbd/db';
import {
  insertAppUserWithEmail,
  insertOrganization,
  insertOrganizationInvite,
  insertOrganizationMember,
  insertReportWithAttempt,
  withRollback,
} from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import { type InviteAuditAction, recordAuditEvent } from '#lib/server/audit.js';
import { database } from '#lib/server/db.js';
import { emailer } from '#lib/server/email.js';
import { auditEventsFor, expectedAuditEvent } from '#lib/server/testing/audit.js';
import { _deleteAccount } from './+server.ts';

let sent: MockInstance<ReturnType<typeof emailer>['transport']['send']>;

beforeEach(() => {
  sent = vi.spyOn(emailer().transport, 'send').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function userExists(transaction: Transaction<Database>, id: UserId): Promise<boolean> {
  const [authUser, appUser] = await Promise.all([
    transaction.selectFrom('auth.users').select('id').where('id', '=', id).executeTakeFirst(),
    transaction.selectFrom('appUser').select('id').where('id', '=', id).executeTakeFirst(),
  ]);
  return authUser !== undefined || appUser !== undefined;
}

describe('_deleteAccount', () => {
  test('deletes the user and their memberships, keeping their reports with no creator', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationMember(transaction, {
        organizationId: organization.id,
        userId: user.id,
      });
      const { report, attempt } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: user.id,
        requestedByUserId: user.id,
        status: 'succeeded',
      });

      const response = await _deleteAccount(transaction, { user });

      expect(response.status).toBe(204);
      expect(await userExists(transaction, user.id)).toBe(false);
      const memberships = await transaction
        .selectFrom('organizationMember')
        .select('organizationId')
        .where('userId', '=', user.id)
        .execute();
      expect(memberships).toEqual([]);
      const kept = await transaction
        .selectFrom('report')
        .select('createdByUserId')
        .where('id', '=', report.id)
        .executeTakeFirst();
      expect(kept).toEqual({ createdByUserId: null });
      const keptAttempt = await transaction
        .selectFrom('analysisAttempt')
        .select('requestedByUserId')
        .where('id', '=', attempt.id)
        .executeTakeFirst();
      expect(keptAttempt).toEqual({ requestedByUserId: null });
    });
  });

  test('an admin of an organization with another admin can delete', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);
      const { organization } = await insertOrganization(transaction, { adminUserId: user.id });
      await insertOrganizationMember(transaction, {
        organizationId: organization.id,
        role: 'admin',
      });

      const response = await _deleteAccount(transaction, { user });

      expect(response.status).toBe(204);
      expect(await userExists(transaction, user.id)).toBe(false);
    });
  });

  describe('invites', () => {
    async function inviteIdsIn(
      transaction: Transaction<Database>,
      organizationId: OrganizationId,
    ): Promise<string[]> {
      const rows = await transaction
        .selectFrom('organizationInvite')
        .select('id')
        .where('organizationId', '=', organizationId)
        .execute();
      return rows.map((row) => row.id);
    }

    test('the ones the user answered are deleted, whatever address they went to', async () => {
      await withRollback(database(), async (transaction) => {
        const user = await insertAppUserWithEmail(transaction);
        const { organization } = await insertOrganization(transaction);
        const answers: {
          action: InviteAuditAction;
          status: OrganizationInviteStatus;
          email: string;
        }[] = [
          { action: 'invite.accepted', status: 'accepted', email: user.email },
          { action: 'invite.declined', status: 'declined', email: user.email },
          { action: 'invite.expired', status: 'expired', email: 'old-address@example.com' },
        ];
        const answered = await Promise.all(
          answers.map(async ({ action, status, email }) => {
            const invite = await insertOrganizationInvite(transaction, {
              organizationId: organization.id,
              email,
              status,
            });
            await recordAuditEvent(transaction, {
              action,
              actor: { userId: user.id },
              target: { type: 'invite', id: invite.id, organizationId: organization.id },
            });
            return invite;
          }),
        );
        expect(await inviteIdsIn(transaction, organization.id)).toHaveLength(answered.length);

        await _deleteAccount(transaction, { user });

        expect(await inviteIdsIn(transaction, organization.id)).toEqual([]);
      });
    });

    test("a pending one to the user's address stays, as does one someone else answered", async () => {
      await withRollback(database(), async (transaction) => {
        const user = await insertAppUserWithEmail(transaction);
        const other = await insertAppUserWithEmail(transaction);
        const { organization } = await insertOrganization(transaction);
        const pending = await insertOrganizationInvite(transaction, {
          organizationId: organization.id,
          email: user.email,
        });
        const answeredByOther = await insertOrganizationInvite(transaction, {
          organizationId: organization.id,
          email: other.email,
          status: 'accepted',
        });
        await recordAuditEvent(transaction, {
          action: 'invite.accepted',
          actor: { userId: other.id },
          target: { type: 'invite', id: answeredByOther.id, organizationId: organization.id },
        });

        await _deleteAccount(transaction, { user });

        expect((await inviteIdsIn(transaction, organization.id)).sort()).toEqual(
          [pending.id, answeredByOther.id].sort(),
        );
      });
    });
  });

  test('writes a user.deleted audit event with no organization', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);

      await _deleteAccount(transaction, { user });

      expect(await auditEventsFor(transaction, user.id)).toEqual([
        expectedAuditEvent({
          action: 'user.deleted',
          actorUserId: user.id,
          target: { type: 'user', id: user.id, organizationId: null },
        }),
      ]);
    });
  });

  test("notifies GBD with the deleted account's address", async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);

      await _deleteAccount(transaction, { user });

      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls[0]?.[0]).toMatchObject({
        kind: 'gbd-user-deleted',
        to: emailer().gbdAddress,
        subject: expect.stringContaining(user.email),
      });
    });
  });

  test('still deletes the account when the GBD notice fails to send', async () => {
    sent.mockRejectedValue(new Error('boom'));

    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);

      const response = await _deleteAccount(transaction, { user });

      expect(response.status).toBe(204);
      expect(await userExists(transaction, user.id)).toBe(false);
    });
  });

  // The check violation aborts the test's transaction, so nothing can be read back here to show the
  // user survived; `account.e2e.ts` shows that against committed rows.
  test('the only admin of an organization gets a 409 last-admin, and GBD hears nothing', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);
      await insertOrganization(transaction, { adminUserId: user.id });

      const response = await _deleteAccount(transaction, { user });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'last-admin' });
      expect(sent).not.toHaveBeenCalled();
    });
  });
});
