import {
  type DatabaseExecutor,
  type OrganizationId,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { sql } from 'kysely';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { recordReportAuditEvent } from '$lib/server/reports/audit';
import { cancelActiveAttempt } from '$lib/server/reports/cancel';
import { requireReportAccess } from '$lib/server/reports/guards';
import { requireReportRouteContext } from '$lib/server/reports/route-context';
import type { RequestHandler } from './$types';

/** Delete a report; requests cancellation of its in-flight attempt too. */
export const DELETE: RequestHandler = async (event) => {
  const { organizationId, reportId, actor } = requireReportRouteContext(event);

  await withDbErrorHandling(() => _deleteReport(database(), { organizationId, reportId, actor }), {
    action: 'delete a report',
    context: { organizationId, reportId },
  });

  return new Response(null, { status: 204 });
};

/** Delete `reportId` — REQUIREMENTS.md § Data deletion.
 *
 * Never writes `analysis_attempt.status`; only a worker does.
 *
 * - 404 if the report doesn't exist in this organization, or is already soft-deleted.
 * - 403 if the caller neither created the report nor is an organization admin.
 */
export async function _deleteReport(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
): Promise<void> {
  const { organizationId, actor } = params;

  await withTransaction(db, async (transaction) => {
    const report = await requireReportAccess(transaction, params, 'delete it');

    const canceled = await cancelActiveAttempt(transaction, report.id);

    await transaction
      .updateTable('report')
      .set({ deletedAt: sql<Date>`now()`, deletedByUserId: actor.userId })
      .where('id', '=', report.id)
      .execute();

    await recordReportAuditEvent(transaction, {
      action: 'report.deleted',
      actor,
      organizationId,
      reportId: report.id,
    });

    if (canceled) {
      await recordReportAuditEvent(transaction, {
        action: 'report.cancel_requested',
        actor,
        organizationId,
        reportId: report.id,
      });
    }
  });
}
