import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { reportAuditEvents } from '$lib/server/tests/audit';
import { organizationAuditEvents } from '$lib/server/tests/organization-audit';
import { recordAuditEvent } from './audit';

describe('recordAuditEvent', () => {
  test('inserts one row naming the action, actor, and organization', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      await recordAuditEvent(transaction, {
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

  test('inserts one row naming the action, actor, organization, and report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });

      await recordAuditEvent(transaction, {
        action: 'report.deleted',
        actor: { userId: admin.id, role: 'admin' },
        organizationId: organization.id,
        reportId: report.id,
      });

      // Spelled out rather than built with `expectedReportAuditEvent`: this is the test that pins the
      // shape that helper claims, so asserting against the helper here would prove nothing.
      expect(await reportAuditEvents(transaction, report.id)).toEqual([
        {
          action: 'report.deleted',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'report',
          targetId: report.id,
        },
      ]);
    });
  });
});
