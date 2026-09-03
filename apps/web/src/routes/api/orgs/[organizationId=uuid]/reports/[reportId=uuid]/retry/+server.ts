import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  type ReportId,
  withTransaction,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { recordReportAuditEvent } from '$lib/server/reports/audit';
import { requireReportAccess } from '$lib/server/reports/guards';
import { requireReportRouteContext } from '$lib/server/reports/route-context';
import type { RequestHandler } from './$types';

/** Retry a failed analysis. */
export const POST: RequestHandler = async (event) => {
  const { organizationId, reportId, actor } = await requireReportRouteContext(database(), event);

  await withDbErrorHandling(() => _retryReport(database(), { organizationId, reportId, actor }), {
    action: 'retry a report',
    context: { organizationId, reportId },
  });

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

  await withTransaction(db, async (transaction) => {
    const report = await requireReportAccess(transaction, params, 'retry it');

    // Every report gets its first attempt atomically with its own insert, so there's always one
    // here — `executeTakeFirstOrThrow` so a broken invariant fails loudly.
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
        isPermanentDatabaseError(cause) &&
        (cause.code === POSTGRES_CODE_CHECK_VIOLATION ||
          cause.code === POSTGRES_CODE_UNIQUE_VIOLATION)
      ) {
        error(409, { message: 'This report cannot be retried right now' });
      }
      throw cause;
    }

    await recordReportAuditEvent(transaction, {
      action: 'report.retry_requested',
      actor,
      organizationId,
      reportId: report.id,
    });
  });
}
