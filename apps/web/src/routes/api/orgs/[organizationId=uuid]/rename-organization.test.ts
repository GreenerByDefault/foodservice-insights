import { insertOrganization, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { organizationAuditEvents } from '$lib/server/tests/organization-audit';
import { _renameOrganization } from './+server.ts';

describe('a valid name', () => {
  test('answers 204 and stores the new name', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      const response = await _renameOrganization(
        transaction,
        { organizationId: organization.id, actor: { userId: admin.id, role: 'admin' } },
        { name: 'Acme Foodservice' },
      );

      expect(response.status).toBe(204);
      const renamed = await transaction
        .selectFrom('organization')
        .select('name')
        .where('id', '=', organization.id)
        .executeTakeFirstOrThrow();
      expect(renamed.name).toBe('Acme Foodservice');
    });
  });

  test('writes an organization.renamed audit event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      await _renameOrganization(
        transaction,
        { organizationId: organization.id, actor: { userId: admin.id, role: 'admin' } },
        { name: 'Acme Foodservice' },
      );

      expect(await organizationAuditEvents(transaction, organization.id)).toEqual([
        {
          action: 'organization.renamed',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'organization',
          targetId: organization.id,
        },
      ]);
    });
  });
});

describe('a name already taken', () => {
  // The UPDATE's unique violation aborts the transaction (see withTransaction's documented
  // join-not-nest trade-off), so nothing is read back afterward — the abort also means the
  // name is never partially applied and the audit event is never recorded.
  test('answers 409 name-taken, case-insensitively', async () => {
    await withRollback(database(), async (transaction) => {
      await insertOrganization(transaction, { name: 'Acme Foodservice' });
      const { organization, admin } = await insertOrganization(transaction, {
        name: 'Riverside Foods',
      });

      const response = await _renameOrganization(
        transaction,
        { organizationId: organization.id, actor: { userId: admin.id, role: 'admin' } },
        { name: 'acme foodservice' },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'name-taken' });
    });
  });
});

describe('an invalid name', () => {
  test.for([null, '', '   ', 'x'.repeat(1000)])('answers 400 for %j', async (name) => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      const response = await _renameOrganization(
        transaction,
        { organizationId: organization.id, actor: { userId: admin.id, role: 'admin' } },
        { name },
      );

      expect(response.status).toBe(400);
    });
  });
});
