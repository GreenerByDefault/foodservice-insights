/** The guarded `cancel_requested_at` write shared by `POST /cancel` and `DELETE` */

import {
  type DatabaseExecutor,
  type OrganizationId,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { sql } from 'kysely';
import type { Actor } from '$lib/server/auth/types';

/** Request cancellation of `reportId`'s in-flight attempt.
 *
 * Never writes `analysis_attempt.status` — only a worker does; this only records that the user
 * asked, and a worker converges the request later.
 *
 * - 404 if the report doesn't exist in this organization, or is already soft-deleted.
 * - 403 if the caller neither created the report nor is an organization admin.
 * - 409 if there is no `pending`/`processing` attempt to cancel: the attempt already finished, so
 *   there is nothing to report as done.
 *
 * `analysis_attempt_one_active_per_report` guarantees at most one attempt is ever `pending` or
 * `processing` for a report, so guarding the update on `report_id` and that status pair is enough
 * — no need to also pin the latest `attempt_number`.
 */
export async function requestCancellation(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
): Promise<void> {
  const { organizationId, reportId, actor } = params;

  await withTransaction(db, async (transaction) => {
    const report = await transaction
      .selectFrom('report')
      .select(['id', 'createdByUserId'])
      .where('id', '=', reportId)
      .where('organizationId', '=', organizationId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!report) error(404, { message: 'Not found', code: 'not_found' });

    if (actor.role !== 'admin' && report.createdByUserId !== actor.userId) {
      error(403, {
        message: "Only the report's creator or an organization admin can cancel it",
        code: 'forbidden',
      });
    }

    const updated = await transaction
      .updateTable('analysisAttempt')
      .set({ cancelRequestedAt: sql<Date>`now()` })
      .where('reportId', '=', report.id)
      .where('status', 'in', ['pending', 'processing'])
      .executeTakeFirst();

    if (updated.numUpdatedRows !== 1n) {
      error(409, { message: 'This report already finished' });
    }

    await transaction
      .insertInto('auditEvent')
      .values({
        action: 'report.cancel_requested',
        actorUserId: actor.userId,
        actorKind: 'user',
        organizationId,
        targetType: 'report',
        targetId: report.id,
      })
      .execute();
  });
}
