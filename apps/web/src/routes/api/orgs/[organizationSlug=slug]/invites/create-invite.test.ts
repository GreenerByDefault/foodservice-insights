import { DAY_MS } from '@gbd/core';
import { insertOrganizationInvite, withRollback } from '@gbd/db/testing';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { HOURLY_INVITE_LIMIT } from '$lib/invites/limits';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { sendInvite } from '$lib/server/email';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationWithMembers } from '$lib/server/testing/fixtures';
import { _createInvite } from './+server.ts';

// `sendInvite`'s own send path is `packages/email`'s job to prove; this only needs to know
// whether the route asked it to send, with what, and how it answers each way `sendInvite` can
// come back.
vi.mock('$lib/server/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/email')>();
  return { ...actual, sendInvite: vi.fn() };
});

beforeEach(() => {
  vi.mocked(sendInvite).mockReset().mockResolvedValue(true);
});

describe('_createInvite', () => {
  test('inserts a pending invite, records invite.created, and sends the invite email', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: 'Ada Admin',
        body: { email: 'invitee@example.test', role: 'member' },
      });

      expect(response.status).toBe(201);
      const { inviteId, emailSent } = await response.json();
      expect(emailSent).toBe(true);

      const invite = await transaction
        .selectFrom('organizationInvite')
        .selectAll()
        .where('id', '=', inviteId)
        .executeTakeFirstOrThrow();
      expect(invite).toMatchObject({
        organizationId,
        email: 'invitee@example.test',
        role: 'member',
        status: 'pending',
        invitedByUserId: admin,
      });

      expect(await auditEventsFor(transaction, inviteId)).toEqual([
        expectedAuditEvent({
          action: 'invite.created',
          actorUserId: admin,
          target: { type: 'invite', id: inviteId, organizationId },
        }),
      ]);

      expect(sendInvite).toHaveBeenCalledExactlyOnceWith({
        kind: 'organization-invite',
        to: 'invitee@example.test',
        organizationName: 'Acme Test',
        role: 'member',
        invitedByName: 'Ada Admin',
        expiresAt: invite.expiresAt,
      });
    });
  });

  test('lowercases and trims the email before matching or writing it', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: null,
        body: { email: '  Invitee@Example.Test  ', role: 'member' },
      });

      expect(response.status).toBe(201);
      const { inviteId } = await response.json();
      const invite = await transaction
        .selectFrom('organizationInvite')
        .select('email')
        .where('id', '=', inviteId)
        .executeTakeFirstOrThrow();
      expect(invite.email).toBe('invitee@example.test');
    });
  });

  test('re-inviting an outstanding address supersedes the old row and extends the expiry', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      const original = await insertOrganizationInvite(transaction, {
        organizationId,
        email: 'invitee@example.test',
        invitedByUserId: admin,
        expiresAt: new Date(Date.now() + DAY_MS),
      });

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: null,
        body: { email: 'invitee@example.test', role: 'admin' },
      });

      expect(response.status).toBe(201);
      const { inviteId } = await response.json();
      expect(inviteId).not.toBe(original.id);

      const rows = await transaction
        .selectFrom('organizationInvite')
        .select(['id', 'status', 'expiresAt'])
        .where('organizationId', '=', organizationId)
        .orderBy('createdAt')
        .execute();
      expect(rows.map((row) => row.status)).toEqual(['superseded', 'pending']);
      const [supersededRow, newRow] = rows as [(typeof rows)[0], (typeof rows)[0]];
      expect(supersededRow.id).toBe(original.id);
      expect(newRow.expiresAt.getTime()).toBeGreaterThan(supersededRow.expiresAt.getTime());
    });
  });

  test('inviting an address that already belongs to the organization answers 409 and writes nothing', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, [
        { role: 'member', email: 'Existing@Example.Test' },
      ]);
      const actor: Actor = { userId: admin, role: 'admin' };

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: null,
        body: { email: 'existing@example.test', role: 'member' },
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'already-member' });

      const invites = await transaction
        .selectFrom('organizationInvite')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .execute();
      expect(invites).toEqual([]);
      expect(sendInvite).not.toHaveBeenCalled();
    });
  });

  test('the invite past the hourly limit answers 429 and writes nothing', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      for (let i = 0; i < HOURLY_INVITE_LIMIT; i++) {
        await insertOrganizationInvite(transaction, {
          organizationId,
          email: `${crypto.randomUUID()}@example.test`,
          invitedByUserId: admin,
        });
      }

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: null,
        body: { email: 'invitee@example.test', role: 'member' },
      });

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: 'rate-limited' });

      const invites = await transaction
        .selectFrom('organizationInvite')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(Number(invites.count)).toBe(HOURLY_INVITE_LIMIT);
      expect(sendInvite).not.toHaveBeenCalled();
    });
  });

  test('an email the emailer cannot reach still answers 201, with emailSent: false', async () => {
    await withRollback(database(), async (transaction) => {
      const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
      const actor: Actor = { userId: admin, role: 'admin' };
      vi.mocked(sendInvite).mockResolvedValueOnce(false);

      const response = await _createInvite(transaction, {
        organizationId,
        organizationName: 'Acme Test',
        actor,
        actorDisplayName: null,
        body: { email: 'invitee@example.test', role: 'member' },
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ emailSent: false });

      // The row is committed either way — a failed send does not undo the invite.
      const invite = await transaction
        .selectFrom('organizationInvite')
        .select('status')
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(invite.status).toBe('pending');
    });
  });

  describe('an invalid body', () => {
    // `parseBody` is tested once against its schema elsewhere (`body.test.ts`); this is the
    // wiring check that the route actually calls it.
    test('an address that is not an email is a 400', async () => {
      await withRollback(database(), async (transaction) => {
        const { organizationId, admin } = await anOrganizationWithMembers(transaction, []);
        const actor: Actor = { userId: admin, role: 'admin' };

        const response = await _createInvite(transaction, {
          organizationId,
          organizationName: 'Acme Test',
          actor,
          actorDisplayName: null,
          body: { email: 'not-an-email', role: 'member' },
        });

        expect(response.status).toBe(400);
      });
    });
  });
});
