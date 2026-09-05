/** Reading back the audit trail that an organization action was supposed to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, UserId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { OrganizationAuditAction } from '../orgs/audit.ts';
import { type AuditEventRow, auditEventsFor } from './audit-event.ts';

export type OrganizationAuditEventRow = AuditEventRow;

/** Every audit row written for `organizationId`, oldest first. */
export async function organizationAuditEvents(
  transaction: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<OrganizationAuditEventRow[]> {
  return await auditEventsFor(transaction, organizationId);
}

/** The row `organizationAuditEvents` should return for one `action` by one user. */
export function expectedOrganizationAuditEvent(params: {
  action: OrganizationAuditAction;
  actorUserId: UserId;
  organizationId: OrganizationId;
}): OrganizationAuditEventRow {
  return {
    action: params.action,
    actorUserId: params.actorUserId,
    actorKind: 'user',
    organizationId: params.organizationId,
    targetType: 'organization',
    targetId: params.organizationId,
  };
}
