import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { auditEventsFor } from '$lib/server/testing/audit';
import { recordAuditEvent } from './audit';

describe('recordAuditEvent', () => {
  test('inserts one row naming the action, actor, and organization', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      await recordAuditEvent(transaction, {
        action: 'organization.renamed',
        actor: { userId: admin.id },
        organizationId: organization.id,
      });

      // Spelled out rather than built with `expectedAuditEvent`: this is the test that pins the
      // shape that helper claims, so asserting against the helper here would prove nothing.
      expect(await auditEventsFor(transaction, organization.id)).toEqual([
        {
          action: 'organization.renamed',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'organization',
          targetId: organization.id,
          detail: null,
        },
      ]);
    });
  });

  test('inserts one row naming the action, actor, organization, and report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });

      await recordAuditEvent(transaction, {
        action: 'report.deleted',
        actor: { userId: admin.id },
        organizationId: organization.id,
        target: { type: 'report', id: report.id },
      });

      // Spelled out rather than built with `expectedAuditEvent`: this is the test that pins the
      // shape that helper claims, so asserting against the helper here would prove nothing.
      expect(await auditEventsFor(transaction, report.id)).toEqual([
        {
          action: 'report.deleted',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'report',
          targetId: report.id,
          detail: null,
        },
      ]);
    });
  });

  test('writes the given detail', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      await recordAuditEvent(transaction, {
        action: 'organization.renamed',
        actor: { userId: admin.id },
        organizationId: organization.id,
        detail: { role: 'admin' },
      });

      expect(await auditEventsFor(transaction, organization.id)).toEqual([
        {
          action: 'organization.renamed',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'organization',
          targetId: organization.id,
          detail: { role: 'admin' },
        },
      ]);
    });
  });
});
