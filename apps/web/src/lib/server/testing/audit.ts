/** Reading back the audit trail that an organization, report, or membership action was supposed
 * to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, UserId } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';
import type { JsonValue } from '$lib/api/fetch';
import type { AuditAction, AuditTarget } from '../audit.ts';

const AUDIT_EVENT_COLUMNS = [
  'action',
  'actorUserId',
  'actorKind',
  'organizationId',
  'targetType',
  'targetId',
  'detail',
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

/** The row `auditEventsFor` should return for one `action` by one user. */
export function expectedAuditEvent(params: {
  action: AuditAction;
  actorUserId: UserId;
  target: AuditTarget;
  detail?: Record<string, JsonValue>;
}): AuditEventRow {
  const { target } = params;
  const organizationId = target.type === 'organization' ? target.id : target.organizationId;

  return {
    action: params.action,
    actorUserId: params.actorUserId,
    actorKind: 'user',
    organizationId,
    targetType: target.type,
    targetId: target.id,
    detail: params.detail ?? null,
  };
}
