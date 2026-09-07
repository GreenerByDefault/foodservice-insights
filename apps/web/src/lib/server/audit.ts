/** The audit row shared by every route that acts on an organization or a report. */

import type { Database, OrganizationId, ReportId } from '@gbd/db';
import type { Transaction } from 'kysely';
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

type AuditEvent =
  | { action: OrganizationAuditAction; actor: Actor; organizationId: OrganizationId }
  | {
      action: ReportAuditAction;
      actor: Actor;
      organizationId: OrganizationId;
      reportId: ReportId;
    };

/** Takes a `Transaction`, not a `DatabaseExecutor`: an audit event only ever makes sense
 * committed atomically with the write it records, never on its own. */
export async function recordAuditEvent(
  transaction: Transaction<Database>,
  event: AuditEvent,
): Promise<void> {
  const { action, actor, organizationId } = event;
  const [targetType, targetId] =
    'reportId' in event
      ? (['report', event.reportId] as const)
      : (['organization', organizationId] as const);

  await transaction
    .insertInto('auditEvent')
    .values({
      action,
      actorUserId: actor.userId,
      actorKind: 'user',
      organizationId,
      targetType,
      targetId,
    })
    .execute();
}
