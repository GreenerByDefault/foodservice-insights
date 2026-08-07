import type {
  AnalysisAttemptStatus,
  AnalysisFailureReason,
  CountsBasis,
  DatabaseExecutor,
  InputFileId,
  ReportId,
  UnitSystem,
} from '@gbd/db';
import { error } from '@sveltejs/kit';
import * as v from 'valibot';
import { type MonthlyCounts, MonthlyCountsSchema } from '$lib/reports/submission';
import { database } from '$lib/server/db';
import { requireSession, type Session } from '$lib/server/session';
import type { PageServerLoad } from './$types';

/** What one report looks like to the page.
 *
 * The attempt carries raw timestamps and nothing derived from them. REQUIREMENTS.md wants a
 * timeline and a warning when a stage runs long, and both have to be computed against the
 * viewer's clock while they watch — a stage decided here would be stale before it arrived.
 */
export type ReportView = {
  id: ReportId;
  name: string | null;
  siteName: string | null;
  countsBasis: CountsBasis;
  unitSystem: UnitSystem;
  monthlyCounts: MonthlyCounts;
  createdAt: Date;
  inputFile: { id: InputFileId; originalFilename: string; byteSize: number };
  attempt: {
    attemptNumber: number;
    status: AnalysisAttemptStatus;
    createdAt: Date;
    lockedAt: Date | null;
    lastHeartbeatAt: Date | null;
    finishedAt: Date | null;
    failureReason: AnalysisFailureReason | null;
  } | null;
};

export const load: PageServerLoad = async ({ params, locals }) => {
  const report = await _loadReport(database(), requireSession(locals), params.id as ReportId);
  return { report };
};

/** One report the session is allowed to see, or a 404.
 *
 * Filtering on the organization is not decoration: it is the check real auth inherits, and the
 * difference between "no such report" and "not yours" is deliberately invisible to the caller.
 */
export async function _loadReport(
  db: DatabaseExecutor,
  session: Session,
  reportId: ReportId,
): Promise<ReportView> {
  const row = await db
    .selectFrom('report')
    .innerJoin('inputFile', 'inputFile.reportId', 'report.id')
    // Lateral rather than `jsonObjectFrom`, which would serialise the timestamps to strings.
    // Served by the unique index on (report_id, attempt_number).
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('analysisAttempt')
          .select([
            'analysisAttempt.attemptNumber',
            'analysisAttempt.status',
            'analysisAttempt.createdAt',
            'analysisAttempt.lockedAt',
            'analysisAttempt.lastHeartbeatAt',
            'analysisAttempt.finishedAt',
            'analysisAttempt.failureReason',
          ])
          .whereRef('analysisAttempt.reportId', '=', 'report.id')
          .orderBy('analysisAttempt.attemptNumber', 'desc')
          .limit(1)
          .as('attempt'),
      (join) => join.onTrue(),
    )
    .select([
      'report.id',
      'report.name',
      'report.siteName',
      'report.countsBasis',
      'report.unitSystem',
      'report.monthlyCounts',
      'report.createdAt',
      'inputFile.id as inputFileId',
      'inputFile.originalFilename',
      'inputFile.byteSize',
      'attempt.attemptNumber',
      'attempt.status',
      'attempt.createdAt as attemptCreatedAt',
      'attempt.lockedAt',
      'attempt.lastHeartbeatAt',
      'attempt.finishedAt',
      'attempt.failureReason',
    ])
    .where('report.id', '=', reportId)
    .where('report.organizationId', '=', session.organization.id)
    .where('report.deletedAt', 'is', null)
    .executeTakeFirst();

  if (!row) error(404, { message: 'That report does not exist.', code: 'not_found' });

  return {
    id: row.id,
    name: row.name,
    siteName: row.siteName,
    countsBasis: row.countsBasis,
    unitSystem: row.unitSystem,
    // Kysely types a `jsonb` column as `unknown`. Narrowing it here means every consumer gets a
    // real type, and a row that somehow does not match throws — which for stored data we wrote
    // ourselves is a bug worth a 500 rather than something to paper over.
    monthlyCounts: v.parse(MonthlyCountsSchema, row.monthlyCounts),
    createdAt: row.createdAt,
    inputFile: {
      id: row.inputFileId,
      originalFilename: row.originalFilename,
      byteSize: row.byteSize,
    },
    // The left join makes the attempt's non-nullable columns null together, but TypeScript
    // cannot know they are correlated — so each one is tested to narrow itself.
    attempt:
      row.attemptNumber === null || row.status === null || row.attemptCreatedAt === null
        ? null
        : {
            attemptNumber: row.attemptNumber,
            status: row.status,
            createdAt: row.attemptCreatedAt,
            lockedAt: row.lockedAt,
            lastHeartbeatAt: row.lastHeartbeatAt,
            finishedAt: row.finishedAt,
            failureReason: row.failureReason,
          },
  };
}
