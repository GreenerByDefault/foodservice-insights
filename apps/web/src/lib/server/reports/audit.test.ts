import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { reportAuditEvents } from '$lib/server/tests/audit';
import { recordReportAuditEvent } from './audit';

describe('recordReportAuditEvent', () => {
  test('inserts one row naming the action, actor, organization, and report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });

      await recordReportAuditEvent(transaction, {
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
