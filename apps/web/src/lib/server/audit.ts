/** The audit row shared by every route. */

import type { Database, OrganizationId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { JsonValue } from '#lib/api/fetch.js';
import type { Actor } from '#lib/server/auth/types.js';

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

/** The `user.*` audit actions a route may record. */
export type UserAuditAction = 'user.deleted';

/** The `invite.*` audit actions a route may record. Supersession is not its own event — the
 * superseded row's status is the record. */
export type InviteAuditAction =
  | 'invite.created'
  | 'invite.revoked'
  | 'invite.accepted'
  | 'invite.declined'
  | 'invite.expired';

export type AuditAction =
  | OrganizationAuditAction
  | ReportAuditAction
  | MemberAuditAction
  | UserAuditAction
  | InviteAuditAction;

/** What the event happened to, and the organization it happened in. A user's own account belongs
 * to no organization, hence the null. */
export type AuditTarget =
  | { type: 'organization'; id: OrganizationId }
  | { type: 'report' | 'invite'; id: string; organizationId: OrganizationId }
  | { type: 'user'; id: string; organizationId: OrganizationId | null };

type AuditEvent = {
  action: AuditAction;
  actor: Pick<Actor, 'userId'>;
  target: AuditTarget;
  detail?: Record<string, JsonValue>;
};

/** Takes a `Transaction`, not a `DatabaseExecutor`: an audit event only ever makes sense
 * committed atomically with the write it records, never on its own. */
export async function recordAuditEvent(
  transaction: Transaction<Database>,
  event: AuditEvent,
): Promise<void> {
  const { action, actor, target, detail } = event;
  const organizationId = target.type === 'organization' ? target.id : target.organizationId;

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
