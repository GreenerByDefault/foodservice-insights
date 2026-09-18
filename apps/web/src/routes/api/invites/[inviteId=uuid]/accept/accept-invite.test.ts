import type { OrganizationInviteId } from '@gbd/db';
import {
  dbMsAgo,
  insertAppUserWithEmail,
  insertOrganization,
  insertOrganizationInvite,
  insertOrganizationMember,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { statusOf } from '$lib/server/testing/http-error';
import { _acceptInvite } from './+server.ts';

describe('_acceptInvite', () => {
  test('joins the organization with the invited role, marks accepted, and records invite.accepted', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
        role: 'admin',
      });

      const response = await _acceptInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ organizationSlug: organization.slug });

      const member = await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organization.id)
        .where('userId', '=', user.id)
        .executeTakeFirstOrThrow();
      expect(member.role).toBe('admin');

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('accepted');

      expect(await auditEventsFor(transaction, invite.id)).toEqual([
        expectedAuditEvent({
          action: 'invite.accepted',
          actorUserId: user.id,
          target: { type: 'invite', id: invite.id, organizationId: organization.id },
        }),
      ]);
    });
  });

  test('matches the invite by the caller email, case-insensitively', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email.toLowerCase(),
      });

      const response = await _acceptInvite(transaction, {
        inviteId: invite.id,
        user: { ...user, email: user.email.toUpperCase() },
      });

      expect(response.status).toBe(200);
    });
  });

  test('accepting as an existing member still marks it accepted', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      await insertOrganizationMember(transaction, {
        organizationId: organization.id,
        userId: user.id,
        role: 'member',
      });
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
        role: 'admin',
      });

      const response = await _acceptInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(200);

      const member = await transaction
        .selectFrom('organizationMember')
        .select('role')
        .where('organizationId', '=', organization.id)
        .where('userId', '=', user.id)
        .executeTakeFirstOrThrow();
      expect(member.role).toBe('member');

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('accepted');
    });
  });

  test('an invite past its expiry is refused, writing expired and audit invite.expired', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const user = await insertAppUserWithEmail(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: user.email,
        expiresAt: dbMsAgo(1000),
      });

      const response = await _acceptInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'expired' });

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('expired');

      const member = await transaction
        .selectFrom('organizationMember')
        .selectAll()
        .where('organizationId', '=', organization.id)
        .where('userId', '=', user.id)
        .executeTakeFirst();
      expect(member).toBeUndefined();

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
        status: 'revoked',
      });

      const response = await _acceptInvite(transaction, { inviteId: invite.id, user });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'no-longer-valid' });

      const updated = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('id', '=', invite.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('revoked');
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
        statusOf(() => _acceptInvite(transaction, { inviteId: invite.id, user: someoneElse })),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('an id that matches no invite at all is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const user = await insertAppUserWithEmail(transaction);

      await expect(
        statusOf(() =>
          _acceptInvite(transaction, {
            inviteId: crypto.randomUUID() as OrganizationInviteId,
            user,
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
