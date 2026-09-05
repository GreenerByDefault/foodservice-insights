/** Reading back the audit trail that an organization action was supposed to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, UserId } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';
import type { OrganizationAuditAction } from '../orgs/audit.ts';

const AUDIT_EVENT_COLUMNS = [
  'action',
  'actorUserId',
  'actorKind',
  'organizationId',
  'targetType',
  'targetId',
] as const;

export type OrganizationAuditEventRow = Pick<
  Selectable<Database['auditEvent']>,
  (typeof AUDIT_EVENT_COLUMNS)[number]
>;

/** Every audit row written for `organizationId`, oldest first. */
export async function organizationAuditEvents(
  transaction: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<OrganizationAuditEventRow[]> {
  return await transaction
    .selectFrom('auditEvent')
    .select(AUDIT_EVENT_COLUMNS)
    .where('targetId', '=', organizationId)
    .orderBy('id')
    .execute();
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
