/** Reading back the audit trail that a report action was supposed to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, ReportId, UserId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { ReportAuditAction } from '../reports/audit.ts';
import { type AuditEventRow, auditEventsFor } from './audit-event.ts';

export type ReportAuditEventRow = AuditEventRow;

/** Every audit row written for `reportId`, oldest first. */
export async function reportAuditEvents(
  transaction: Transaction<Database>,
  reportId: ReportId,
): Promise<ReportAuditEventRow[]> {
  return await auditEventsFor(transaction, reportId);
}

/** The row `reportAuditEvents` should return for one `action` by one user. */
export function expectedReportAuditEvent(params: {
  action: ReportAuditAction;
  actorUserId: UserId;
  organizationId: OrganizationId;
  reportId: ReportId;
}): ReportAuditEventRow {
  return {
    action: params.action,
    actorUserId: params.actorUserId,
    actorKind: 'user',
    organizationId: params.organizationId,
    targetType: 'report',
    targetId: params.reportId,
  };
}
