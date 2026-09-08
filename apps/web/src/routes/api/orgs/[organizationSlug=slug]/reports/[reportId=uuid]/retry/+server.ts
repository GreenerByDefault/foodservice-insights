import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_CHECK_VIOLATION,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import { recordAuditEvent } from '$lib/server/audit';
import { requireReportRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { database, isUniqueViolation, withDbErrorHandling } from '$lib/server/db';
import { requireReportAccess } from '$lib/server/reports/guards';
import type { RequestHandler } from './$types';

/** Retry a failed analysis. */
export const POST: RequestHandler = async (event) => {
  const { organizationId, reportId, actor } = await requireReportRouteContext(database(), event);

  await _retryReport(database(), { organizationId, reportId, actor });

  return new Response(null, { status: 204 });
};

/** Insert the next `analysis_attempt` for `reportId`, so a worker can claim it. A retry is a new
 * attempt, never a mutation of the old one.
 *
 * - 404 if the report doesn't exist in this organization, or is already soft-deleted.
 * - 403 if the caller neither created the report nor is an organization admin.
 * - 409 if the latest attempt isn't `failed`, or the report already has `MAX_ANALYSIS_ATTEMPTS`
 *   attempts.
 */
export async function _retryReport(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; reportId: ReportId; actor: Actor },
): Promise<void> {
  const { organizationId, actor } = params;

  await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        const report = await requireReportAccess(transaction, params, 'retry it');

        // Every report gets its first attempt atomically with its own insert, so there's always
        // one here — `executeTakeFirstOrThrow` so a broken invariant fails loudly.
        const latest = await transaction
          .selectFrom('analysisAttempt')
          .select('attemptNumber')
          .where('reportId', '=', report.id)
          .orderBy('attemptNumber', 'desc')
          .executeTakeFirstOrThrow();

        try {
          await transaction
            .insertInto('analysisAttempt')
            .values({
              reportId: report.id,
              attemptNumber: latest.attemptNumber + 1,
              status: 'pending',
              requestedByUserId: actor.userId,
            })
            .execute();
        } catch (cause) {
          if (
            isUniqueViolation(cause) ||
            (isPermanentDatabaseError(cause) && cause.code === POSTGRES_CODE_CHECK_VIOLATION)
          ) {
            error(409, { message: 'This report cannot be retried right now' });
          }
          throw cause;
        }

        await recordAuditEvent(transaction, {
          action: 'report.retry_requested',
          actor,
          organizationId,
          reportId: report.id,
        });
      }),
    { action: 'retry a report', context: { organizationId, reportId: params.reportId } },
  );
}
