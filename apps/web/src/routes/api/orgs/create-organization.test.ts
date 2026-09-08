import { type OrganizationId, RESERVED_ORGANIZATION_SLUGS } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import { describe, expect, test, vi } from 'vitest';
import { database } from '$lib/server/db';
import { auditEventsFor, expectedAuditEvent } from '$lib/server/testing/audit';
import { anOrganizationCreator, mockUnreachableEmailer } from '$lib/server/testing/fixtures';
import { _createOrganization } from './+server.ts';

vi.mock('$lib/server/email', (importOriginal) => mockUnreachableEmailer(importOriginal));

describe('a valid name', () => {
  test('answers 201 with a location header', async () => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme Foodservice',
      });

      expect(response.status).toBe(201);
      // The location is the derived slug, not the id — see `deriveOrganizationSlug`.
      expect(response.headers.get('location')).toBe('/orgs/acme-foodservice');
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
        createdByUserId: creator.actor.userId,
      });

      const members = await transaction
        .selectFrom('organizationMember')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .execute();
      expect(members).toEqual([
        expect.objectContaining({ userId: creator.actor.userId, organizationId, role: 'admin' }),
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

      expect(await auditEventsFor(transaction, organizationId)).toEqual([
        expectedAuditEvent({
          action: 'organization.created',
          actorUserId: creator.actor.userId,
          organizationId,
          targetType: 'organization',
          targetId: organizationId,
        }),
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

describe('a name that derives to a taken slug', () => {
  // Two distinct names deriving to the same slug — the only way to reach this without also
  // tripping `name-taken` first, since names are already unique.
  test('answers 409 slug-taken', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction, { name: 'Acme Inc', slug: 'acme-inc' });
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, {
        name: 'Acme, Inc.',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'slug-taken', slug: 'acme-inc' });
    });
  });
});

describe('a name with no address to derive', () => {
  test.for(['———', '日本語'])('answers 422 slug-underivable for %j', async (name) => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, { name });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'slug-underivable' });
    });
  });
});

describe('a name that derives to a reserved slug', () => {
  test.for(RESERVED_ORGANIZATION_SLUGS)('answers 422 slug-reserved for %j', async (reserved) => {
    await withRollback(database(), async (transaction) => {
      const creator = await anOrganizationCreator(transaction);

      const response = await _createOrganization(transaction, creator, { name: reserved });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'slug-reserved' });
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
