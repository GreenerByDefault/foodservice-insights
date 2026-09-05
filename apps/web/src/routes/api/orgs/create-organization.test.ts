import type { OrganizationId } from '@gbd/db';
import { insertAppUserWithEmail, insertOrganization, withRollback } from '@gbd/db/testing';
import { unreachableEmailer } from '@gbd/email/testing';
import { describe, expect, test, vi } from 'vitest';
import { database } from '$lib/server/db';
import { _createOrganization, type OrganizationCreator } from './+server.ts';

// Aimed at a port nothing listens on, so every test proves `notifyGbd`'s own catch rather than
// depending on whatever Mailpit happens to be doing locally.
vi.mock('$lib/server/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/email')>();
  return { ...actual, emailer: () => unreachableEmailer() };
});

describe('a valid name', () => {
  test('answers 201 with a location header', async () => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme Foodservice',
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as { organizationId: OrganizationId };
      expect(response.headers.get('location')).toBe(`/orgs/${body.organizationId}`);
    });
  });

  test('creates the organization with its creator as the sole admin', async () => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme Foodservice',
      });
      const { organizationId } = (await response.json()) as { organizationId: OrganizationId };

      const organization = await transaction
        .selectFrom('organization')
        .selectAll()
        .where('id', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(organization).toMatchObject({
        name: 'Acme Foodservice',
        createdByUserId: creator.userId,
      });

      const members = await transaction
        .selectFrom('organizationMember')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .execute();
      expect(members).toEqual([
        expect.objectContaining({ userId: creator.userId, organizationId, role: 'admin' }),
      ]);
    });
  });

  test('writes an organization.created audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme Foodservice',
      });
      const { organizationId } = (await response.json()) as { organizationId: OrganizationId };

      const events = await transaction
        .selectFrom('auditEvent')
        .select(['action', 'actorUserId', 'actorKind', 'organizationId', 'targetType', 'targetId'])
        .where('targetId', '=', organizationId)
        .execute();
      expect(events).toEqual([
        {
          action: 'organization.created',
          actorUserId: creator.userId,
          actorKind: 'user',
          organizationId,
          targetType: 'organization',
          targetId: organizationId,
        },
      ]);
    });
  });

  // The notification is best effort, and this is the only thing holding that: `notifyGbd` uses
  // an unreachable emailer in every test in this file (see the mock above), so a passing suite
  // here already proves the organization survives that failure.
  test('still creates the organization when the GBD notice fails to send', async () => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme Foodservice',
      });

      expect(response.status).toBe(201);
      const { organizationId } = (await response.json()) as { organizationId: OrganizationId };
      const organization = await transaction
        .selectFrom('organization')
        .select('id')
        .where('id', '=', organizationId)
        .executeTakeFirst();
      expect(organization).toBeDefined();
    });
  });
});

describe('a name already taken', () => {
  // The unique violation comes from the insert itself, which leaves the transaction aborted —
  // see withTransaction's documented join-not-nest trade-off — so this doesn't try to read
  // anything back afterward. withRollback discards the attempt either way.
  test('answers 409 name-taken, case-insensitively', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction, { name: 'Acme Foodservice' });
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'acme foodservice',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'name-taken' });
    });
  });
});

describe('an invalid name', () => {
  test.for([null, '', '   ', 'x'.repeat(1000)])('answers 400 for %j', async (name) => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, { name });

      expect(response.status).toBe(400);
    });
  });
});

async function anOrganizationCreator(
  transaction: Parameters<typeof insertAppUserWithEmail>[0],
): Promise<OrganizationCreator> {
  const user = await insertAppUserWithEmail(transaction);
  return { userId: user.id, actorEmail: user.email };
}
