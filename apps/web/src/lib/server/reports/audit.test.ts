import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
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

      const event = await transaction
        .selectFrom('auditEvent')
        .select(['action', 'actorUserId', 'actorKind', 'organizationId', 'targetType', 'targetId'])
        .where('targetId', '=', report.id)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({
        action: 'report.deleted',
        actorUserId: admin.id,
        actorKind: 'user',
        organizationId: organization.id,
        targetType: 'report',
        targetId: report.id,
      });
    });
  });
});
