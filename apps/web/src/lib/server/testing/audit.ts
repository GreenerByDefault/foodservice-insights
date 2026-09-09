/** Reading back the audit trail that an organization, report, or membership action was supposed
 * to leave.
 *
 * The helpers intentionally read all rows to make sure extra rows were not written.
 */

import type { Database, OrganizationId, UserId } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';
import type { JsonValue } from '$lib/api/fetch';
import type { AuditAction } from '../audit.ts';

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

/** The row `auditEventsFor` should return for one `action` by one user. `target` defaults to the
 * organization itself, matching `recordAuditEvent`'s own default. */
export function expectedAuditEvent(params: {
  action: AuditAction;
  actorUserId: UserId;
  organizationId: OrganizationId;
  target?: { type: 'report' | 'user' | 'invite'; id: string };
  detail?: Record<string, JsonValue>;
}): AuditEventRow {
  const target = params.target ?? { type: 'organization' as const, id: params.organizationId };

  return {
    action: params.action,
    actorUserId: params.actorUserId,
    actorKind: 'user',
    organizationId: params.organizationId,
    targetType: target.type,
    targetId: target.id,
    detail: params.detail ?? null,
  };
}
