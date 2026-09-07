/** Reading back the audit trail that an organization or report action was supposed to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, ReportId, UserId } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';
import type { OrganizationAuditAction, ReportAuditAction } from '../audit.ts';

const AUDIT_EVENT_COLUMNS = [
  'action',
  'actorUserId',
  'actorKind',
  'organizationId',
  'targetType',
  'targetId',
] as const;

type AuditEventRow = Pick<Selectable<Database['auditEvent']>, (typeof AUDIT_EVENT_COLUMNS)[number]>;

/** Every audit row written for `targetId`, oldest first. */
export async function auditEventsFor(
  transaction: Transaction<Database>,
  targetId: string,
): Promise<AuditEventRow[]> {
  return await transaction
    .selectFrom('auditEvent')
    .select(AUDIT_EVENT_COLUMNS)
    .where('targetId', '=', targetId)
    .orderBy('id')
    .execute();
}

/** The row `auditEventsFor` should return for one `action` by one user, against an organization or
 * a report. */
export function expectedAuditEvent(params: {
  action: OrganizationAuditAction | ReportAuditAction;
  actorUserId: UserId;
  organizationId: OrganizationId;
  targetType: 'organization' | 'report';
  targetId: OrganizationId | ReportId;
}): AuditEventRow {
  return {
    action: params.action,
    actorUserId: params.actorUserId,
    actorKind: 'user',
    organizationId: params.organizationId,
    targetType: params.targetType,
    targetId: params.targetId,
  };
}
