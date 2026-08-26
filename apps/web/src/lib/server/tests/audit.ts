/** Reading back the audit trail that a report action was supposed to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, ReportId, UserId } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';
import type { ReportAuditAction } from '../reports/audit.ts';

const AUDIT_EVENT_COLUMNS = [
  'action',
  'actorUserId',
  'actorKind',
  'organizationId',
  'targetType',
  'targetId',
] as const;

export type ReportAuditEventRow = Pick<
  Selectable<Database['auditEvent']>,
  (typeof AUDIT_EVENT_COLUMNS)[number]
>;

/** Every audit row written for `reportId`, oldest first. */
export async function reportAuditEvents(
  transaction: Transaction<Database>,
  reportId: ReportId,
): Promise<ReportAuditEventRow[]> {
  return await transaction
    .selectFrom('auditEvent')
    .select(AUDIT_EVENT_COLUMNS)
    .where('targetId', '=', reportId)
    .orderBy('id')
    .execute();
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
