/** The guarded `cancel_requested_at` write shared by `POST /cancel` and `DELETE` */

import {
  type Database,
  type DatabaseExecutor,
  type OrganizationId,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { sql, type Transaction } from 'kysely';
import type { Actor } from '$lib/server/auth/types';
import { recordReportAuditEvent } from '$lib/server/reports/audit';
import { requireReportAccess } from '$lib/server/reports/guards';

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
export async function requestCancellation(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
): Promise<void> {
  const { organizationId, actor } = params;

  await withTransaction(db, async (transaction) => {
    const report = await requireReportAccess(transaction, params, 'cancel it');

    if (!(await cancelActiveAttempt(transaction, report.id))) {
      error(409, { message: 'This report already finished' });
    }

    await recordReportAuditEvent(transaction, {
      action: 'report.cancel_requested',
      actor,
      organizationId,
      reportId: report.id,
    });
  });
}

/** Record `cancel_requested_at` on `reportId`'s attempt if one is still `pending`/`processing`.
 *
 * `analysis_attempt_one_active_per_report` guarantees at most one attempt is ever `pending` or
 * `processing` for a report, so guarding on `report_id` and that status pair is enough — no need
 * to also pin the latest `attempt_number`.
 *
 * Returns whether an attempt was actually found to cancel.
 *
 * Takes a `Transaction`, not a `DatabaseExecutor`: every caller pairs this with an audit write
 * that must commit or roll back with it atomically.
 */
export async function cancelActiveAttempt(
  transaction: Transaction<Database>,
  reportId: ReportId,
): Promise<boolean> {
  const updated = await transaction
    .updateTable('analysisAttempt')
    .set({ cancelRequestedAt: sql<Date>`now()` })
    .where('reportId', '=', reportId)
    .where('status', 'in', ['pending', 'processing'])
    .executeTakeFirst();

  return updated.numUpdatedRows === 1n;
}
