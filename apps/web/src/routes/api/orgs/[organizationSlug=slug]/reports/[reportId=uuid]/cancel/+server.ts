import {
  type DatabaseExecutor,
  type OrganizationId,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { recordAuditEvent } from '#lib/server/audit.js';
import { requireReportRouteContext } from '#lib/server/auth/route-context.js';
import type { Actor } from '#lib/server/auth/types.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import { cancelActiveAttempt } from '#lib/server/reports/cancel.js';
import { requireReportAccess } from '#lib/server/reports/guards.js';
import type { RequestHandler } from './$types';

/** Cancel a running analysis. */
export const POST: RequestHandler = async (event) => {
  const { organizationId, reportId, actor } = await requireReportRouteContext(database(), event);

  return await _cancelReport(database(), { organizationId, reportId, actor });
};

/** Request cancellation of `reportId`'s in-flight attempt.
 *
 * Never writes `analysis_attempt.status` — only a worker does; this only records that the user
 * asked, and a worker converges the request later.
 *
 * - 404 if the report doesn't exist in this organization, or is already soft-deleted.
 * - 403 if the caller neither created the report nor is an organization admin.
 * - 409 if there is no `pending`/`processing` attempt to cancel: the attempt already finished, so
 *   there is nothing to report as done.
 */
export async function _cancelReport(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
): Promise<Response> {
  const { organizationId, actor } = params;

  await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        const report = await requireReportAccess(transaction, params, 'cancel it');

        if (!(await cancelActiveAttempt(transaction, report.id))) {
          error(409, 'This report already finished');
        }

        await recordAuditEvent(transaction, {
          action: 'report.cancel_requested',
          actor,
          target: { type: 'report', id: report.id, organizationId },
        });
      }),
    { action: 'cancel a report', context: { organizationId, reportId: params.reportId } },
  );

  return new Response(null, { status: 204 });
}
