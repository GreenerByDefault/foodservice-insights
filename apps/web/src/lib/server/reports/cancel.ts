/** The guarded `cancel_requested_at` write shared by `POST /cancel` and `DELETE` */

import type { Database, ReportId } from '@gbd/db';
import { sql, type Transaction } from 'kysely';

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
