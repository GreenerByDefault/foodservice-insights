/** The report-scoped audit row shared by every route that acts on a single report. */

import type { Database, OrganizationId, ReportId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { Actor } from '$lib/server/auth/types';

/** The `report.*` audit actions a route may record. Extend this as new report actions are added. */
export type ReportAuditAction = 'report.deleted' | 'report.cancel_requested';

/** Takes a `Transaction`, not a `DatabaseExecutor`: an audit event only ever makes sense
 * committed atomically with the write it records, never on its own. */
export async function recordReportAuditEvent(
  transaction: Transaction<Database>,
  params: {
    action: ReportAuditAction;
    actor: Actor;
    organizationId: OrganizationId;
    reportId: ReportId;
  },
): Promise<void> {
  const { action, actor, organizationId, reportId } = params;

  await transaction
    .insertInto('auditEvent')
    .values({
      action,
      actorUserId: actor.userId,
      actorKind: 'user',
      organizationId,
      targetType: 'report',
      targetId: reportId,
    })
    .execute();
}
