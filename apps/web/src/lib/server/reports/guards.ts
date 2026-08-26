/** The ownership check shared by every route that acts on a single report. */

import type { Database, OrganizationId, ReportId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import type { Transaction } from 'kysely';
import type { Actor } from '$lib/server/auth/types';

/** The report `reportId`, if `actor` may act on it — a 404 or 403 otherwise.
 *
 * - 404 if the report doesn't exist in this organization, or is already soft-deleted.
 * - 403 if `actor` neither created the report nor is an organization admin. `verb` names the
 *   forbidden action in the message, e.g. "cancel it" or "delete it".
 *
 * Takes a `Transaction`, not a `DatabaseExecutor`: every caller acts on the report right after
 * checking it, and that has to happen in the same transaction or the check races the write.
 */
export async function requireReportAccess(
  transaction: Transaction<Database>,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
  verb: string,
) {
  const { organizationId, reportId, actor } = params;

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
      message: `Only the report's creator or an organization admin can ${verb}`,
      code: 'forbidden',
    });
  }

  return report;
}
