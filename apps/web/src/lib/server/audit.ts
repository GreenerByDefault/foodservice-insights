/** The audit row shared by every route. */

import type { Database, OrganizationId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { JsonValue } from '$lib/api/fetch';
import type { Actor } from '$lib/server/auth/types';

/** The `organization.*` audit actions a route may record. Extend this as new organization
 * actions are added. */
export type OrganizationAuditAction =
  | 'organization.created'
  | 'organization.renamed'
  | 'organization.deleted';

/** The `report.*` audit actions a route may record. Extend this as new report actions are added. */
export type ReportAuditAction =
  | 'report.deleted'
  | 'report.cancel_requested'
  | 'report.retry_requested';

/** The `member.*` audit actions a route may record. Extend this as new membership actions are
 * added. */
export type MemberAuditAction = 'member.role_changed' | 'member.removed' | 'member.left';

export type AuditAction = OrganizationAuditAction | ReportAuditAction | MemberAuditAction;

/** What the event happened to, beyond the organization itself. Defaults to the organization when
 * omitted — every `organization.*` action, and nothing else. */
type AuditTarget = { type: 'report' | 'user' | 'invite'; id: string };

type AuditEvent = {
  action: AuditAction;
  actor: Pick<Actor, 'userId'>;
  organizationId: OrganizationId | null;
  target?: AuditTarget;
  detail?: Record<string, JsonValue>;
};

/** Takes a `Transaction`, not a `DatabaseExecutor`: an audit event only ever makes sense
 * committed atomically with the write it records, never on its own. */
export async function recordAuditEvent(
  transaction: Transaction<Database>,
  event: AuditEvent,
): Promise<void> {
  const { action, actor, organizationId, detail } = event;
  const target = event.target ?? { type: 'organization' as const, id: organizationId };

  await transaction
    .insertInto('auditEvent')
    .values({
      action,
      actorUserId: actor.userId,
      actorKind: 'user',
      organizationId,
      targetType: target.type,
      targetId: target.id,
      detail: detail ?? null,
    })
    .execute();
}
