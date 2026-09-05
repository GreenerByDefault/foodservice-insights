import { insertOrganization, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { organizationAuditEvents } from '$lib/server/tests/organization-audit';
import { recordOrganizationAuditEvent } from './audit';

describe('recordOrganizationAuditEvent', () => {
  test('inserts one row naming the action, actor, and organization', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      await recordOrganizationAuditEvent(transaction, {
        action: 'organization.renamed',
        actor: { userId: admin.id, role: 'admin' },
        organizationId: organization.id,
      });

      // Spelled out rather than built with `expectedOrganizationAuditEvent`: this is the test that
      // pins the shape that helper claims, so asserting against the helper here would prove nothing.
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
