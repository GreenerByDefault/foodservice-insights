/** The catalogue of report states the report page can show, and the rows that produce each one.
 *
 * Every state commits inside one `withTransaction`: `report_has_an_input_file` and
 * `analysis_attempt_succeeded_has_result_files` are `DEFERRABLE INITIALLY DEFERRED`, so a report
 * inserted on its own — or a `succeeded` attempt committed ahead of its result files — fails at
 * `COMMIT`, not at `INSERT`. `withRollback` never reaches that failure because it never commits;
 * these fixtures do, so they don't get that pass.
 *
 * `report.created_at` is always an offset from one `ANCHOR`, fixed well outside
 * `HOURLY_REPORT_LIMIT`/`WEEKLY_REPORT_LIMIT`'s rolling windows, so seeding these reports never
 * spends the organization's rate-limit budget (that's what the limit counts against —
 * see `countReportsSince`). The exceptions are the timestamps a screen renders relative to "now"
 * rather than as an absolute date which are recent instead, via `dbMsAgo` (`@gbd/db/testing`) —
 * Postgres's own clock, not `msAgo`'s (`@gbd/core`), since that "now" is `ReportPageData.now`,
 * itself Postgres's `now()`; backdating from the JS clock instead drifts against it, most
 * visibly across a host suspend/resume, and can round to the wrong hour or minute.
 */

import { HOUR_MS, SECOND_MS } from '@gbd/core';
import type {
  AnalysisAttemptStatus,
  AnalysisFailureReason,
  CountsBasis,
  Database,
  OrganizationId,
  ReportId,
  UnitSystem,
  UserId,
} from '@gbd/db';
import { MAX_ANALYSIS_ATTEMPTS, withTransaction } from '@gbd/db';
import {
  dbMsAgo,
  findOrInsertAppUser,
  insertAnalysisAttempt,
  insertAnalysisAttemptFinding,
  insertAppUser,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { ANALYSIS_WARNING_AFTER_MS, QUEUE_WARNING_AFTER_MS } from '../../src/lib/reports/limits.ts';

const ANCHOR = new Date('2026-01-15T09:00:00Z');

function after(seconds: number): Date {
  return new Date(ANCHOR.getTime() + seconds * 1000);
}

export type ReportState =
  | 'pending'
  | 'pending-delayed'
  | 'processing'
  | 'processing-delayed'
  | 'succeeded'
  | 'failed'
  | 'failed-retried'
  | 'failed-at-retry-cap'
  | 'canceled';

/** Every fixture report is created the same way: one report, one input file, backdated to
 * `ANCHOR` (see the file header).
 *
 * `siteName` and `createdByUserId` default to null, the shape most states don't care about: no
 * site, and the heading's "a deleted user" branch. `buildSucceeded` and `buildFailed` pass one so
 * the heading's other branches get exercised too, without a screenshot dedicated to each. They
 * likewise split the upload details' units and counts bases between them.
 */
async function insertReportWithInputFile(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
  name: string,
  overrides: {
    siteName?: string;
    createdByUserId?: UserId;
    unitSystem?: UnitSystem;
    countsBasis?: CountsBasis;
    monthlyCounts?: Record<string, number>;
  } = {},
): Promise<ReportId> {
  const report = await insertReport(tx, {
    ...overrides,
    organizationId,
    name,
    createdAt: ANCHOR,
    siteName: overrides.siteName ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
  });
  await insertInputFile(tx, { reportId: report.id });
  return report.id;
}

type ReportBuilder = (
  tx: Transaction<Database>,
  organizationId: OrganizationId,
) => Promise<ReportId>;

function buildPending(name: string, queuedForMs: number): ReportBuilder {
  return async (tx, organizationId) => {
    const reportId = await insertReportWithInputFile(tx, organizationId, name);
    await insertAnalysisAttempt(tx, {
      reportId,
      status: 'pending',
      createdAt: dbMsAgo(queuedForMs),
    });
    return reportId;
  };
}

function buildProcessing(name: string, queuedForMs: number, analyzingForMs: number): ReportBuilder {
  return async (tx, organizationId) => {
    const reportId = await insertReportWithInputFile(tx, organizationId, name);
    await insertAnalysisAttempt(tx, {
      reportId,
      status: 'processing',
      createdAt: dbMsAgo(queuedForMs + analyzingForMs),
      claimedAt: dbMsAgo(analyzingForMs),
    });
    return reportId;
  };
}

async function buildSucceeded(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<ReportId> {
  // The screen most likely to be shown off, so it's the one that carries the full heading.
  const creator = await insertAppUser(tx, { displayName: 'Dana Cook' });
  const reportId = await insertReportWithInputFile(tx, organizationId, 'Q1 Procurement', {
    siteName: 'Lakeside Grill',
    createdByUserId: creator.id,
    unitSystem: 'lb',
    countsBasis: 'people',
    monthlyCounts: { '2026-01': 4250, '2026-02': 3980, '2026-03': 4410 },
  });
  const finishedMsAgo = 3 * HOUR_MS;
  const attempt = await insertAnalysisAttempt(tx, {
    reportId,
    status: 'succeeded',
    createdAt: dbMsAgo(finishedMsAgo + 210 * SECOND_MS),
    claimedAt: dbMsAgo(finishedMsAgo + 180 * SECOND_MS),
    finishedAt: dbMsAgo(finishedMsAgo),
  });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'pdf' });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'xlsx' });
  // Worded as the real checks word them, so the notice is shown with copy of a realistic length.
  await insertAnalysisAttemptFinding(tx, attempt.id, {
    position: 0,
    qualityCheck: 'per_product_weight_bounds',
    message:
      'Found 3 lines with a weight above zero but under 0.1 lb, or over 2,000 lb, which usually ' +
      'means a unit mistake. For example, Whole Milk 1 Gal at 4,800 lb, above the upper bound ' +
      'of 2,000 lb.',
    sampleValues: [
      'Whole Milk 1 Gal at 4,800 lb, above the upper bound of 2,000 lb.',
      'Russet Potatoes 50 Lb Bag at 2,650 lb, above the upper bound of 2,000 lb.',
      'Ground Cinnamon at 0.02 lb, below the lower bound of 0.1 lb.',
    ],
  });
  await insertAnalysisAttemptFinding(tx, attempt.id, {
    position: 1,
    qualityCheck: 'month_over_month_total_volatility',
    message:
      'Found 1 month where the total pounds changed by more than 50% from the month before. ' +
      'Large swings like this often mean a month is missing, partial, or counted twice.',
    sampleValues: ['Feb 2026: 6,120 lb against 14,380 lb in Jan 2026 (-57%).'],
  });
  return reportId;
}

/** `totalAttempts` failed attempts an hour apart, the last carrying `failureReason` — the
 * earlier ones don't need one, since only the latest attempt's reason drives the page's copy.
 */
async function insertFailedAttempts(
  tx: Transaction<Database>,
  reportId: ReportId,
  totalAttempts: number,
  failureReason: AnalysisFailureReason,
): Promise<void> {
  // Every earlier attempt must itself be `failed` before the next may exist at all.
  for (let attemptNumber = 1; attemptNumber < totalAttempts; attemptNumber++) {
    await insertAnalysisAttempt(tx, {
      reportId,
      attemptNumber,
      status: 'failed',
      createdAt: after(3_600 * attemptNumber),
      finishedAt: after(3_600 * attemptNumber + 90),
    });
  }
  await insertAnalysisAttempt(tx, {
    reportId,
    attemptNumber: totalAttempts,
    status: 'failed',
    createdAt: after(3_600 * totalAttempts),
    finishedAt: after(3_600 * totalAttempts + 90),
    failureReason,
  });
}

async function buildFailed(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<ReportId> {
  // A creator with no display name, so the heading's email-fallback branch gets exercised. A
  // fixed email, not the default random one — this fixture renders into a committed screenshot —
  // and so found rather than inserted when a repeat of the test already made them.
  const creator = await findOrInsertAppUser(tx, { email: 'jordan@example.test' });
  const reportId = await insertReportWithInputFile(tx, organizationId, 'January Dairy', {
    createdByUserId: creator.id,
    unitSystem: 'kg',
    countsBasis: 'meals',
    monthlyCounts: { '2026-01': 18400 },
  });
  await insertAnalysisAttempt(tx, {
    reportId,
    status: 'failed',
    createdAt: ANCHOR,
    finishedAt: after(90),
    failureReason: 'child_crashed',
  });
  return reportId;
}

/** A second attempt has already failed, but there's still room to retry again. */
async function buildFailedRetried(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, organizationId, 'March Seafood');
  await insertFailedAttempts(tx, reportId, 2, 'child_crashed');
  return reportId;
}

/** At `MAX_ANALYSIS_ATTEMPTS`, with a reason whose own follow-up would otherwise say "retry". */
async function buildFailedAtRetryCap(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, organizationId, 'April Beverages');
  await insertFailedAttempts(tx, reportId, MAX_ANALYSIS_ATTEMPTS, 'child_crashed');
  return reportId;
}

async function buildCanceled(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, organizationId, 'May Seafood');
  const stoppedMsAgo = 2 * HOUR_MS;
  await insertAnalysisAttempt(tx, {
    reportId,
    status: 'canceled',
    createdAt: dbMsAgo(stoppedMsAgo + 45 * SECOND_MS),
    cancelRequestedAt: dbMsAgo(stoppedMsAgo),
  });
  return reportId;
}

const BUILDERS: Record<ReportState, ReportBuilder> = {
  pending: buildPending('March Produce', 5_000),
  'pending-delayed': buildPending('June Dry Goods', QUEUE_WARNING_AFTER_MS + 30_000),
  processing: buildProcessing('February Proteins', 70_000, 20_000),
  'processing-delayed': buildProcessing(
    'August Meats',
    100_000,
    ANALYSIS_WARNING_AFTER_MS + 100_000,
  ),
  succeeded: buildSucceeded,
  failed: buildFailed,
  'failed-retried': buildFailedRetried,
  'failed-at-retry-cap': buildFailedAtRetryCap,
  canceled: buildCanceled,
};

/** Commit one report in `state`, in `organizationId`. Returns its id. */
export async function insertReportFixture(
  db: Kysely<Database>,
  state: ReportState,
  organizationId: OrganizationId,
): Promise<ReportId> {
  return await withTransaction(db, (tx) => BUILDERS[state](tx, organizationId));
}

/** Finish the report's newest attempt from underneath an open page, as the worker would.
 *
 * Ordering by `attemptNumber` is what makes this safe on a retried report, where the attempt the
 * page is watching is not the only one — the same ordering the route's own load uses.
 */
export async function succeedLatestAttempt(
  db: Kysely<Database>,
  reportId: ReportId,
): Promise<void> {
  const attempt = await db
    .selectFrom('analysisAttempt')
    .select('id')
    .where('reportId', '=', reportId)
    .orderBy('attemptNumber', 'desc')
    .executeTakeFirstOrThrow();

  await withTransaction(db, async (transaction) => {
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
    await transaction
      .updateTable('analysisAttempt')
      .set({ status: 'succeeded', claimedAt: sql<Date>`now()`, finishedAt: sql<Date>`now()` })
      .where('id', '=', attempt.id)
      .execute();
  });
}

export type ReportWithAttemptSpec = {
  organizationId: OrganizationId;
  name: string;
  siteName?: string | null;
  createdByUserId?: UserId | null;
  createdAt: Date | RawBuilder<Date>;
  status: AnalysisAttemptStatus;
  claimedAt?: Date | RawBuilder<Date>;
  finishedAt?: Date | RawBuilder<Date>;
  cancelRequestedAt?: Date | RawBuilder<Date>;
};

/** One committed report: the input file (and, when `status` is `succeeded`, both result files)
 * land in the same transaction as the report — see the file header for why. Returns its id.
 */
export async function insertReportWithAttempt(
  tx: Transaction<Database>,
  spec: ReportWithAttemptSpec,
): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: spec.organizationId,
    name: spec.name,
    siteName: spec.siteName ?? null,
    createdByUserId: spec.createdByUserId ?? null,
    createdAt: spec.createdAt,
  });
  await insertInputFile(tx, { reportId: report.id });
  const attempt = await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: spec.status,
    createdAt: spec.createdAt,
    claimedAt: spec.claimedAt,
    finishedAt: spec.finishedAt,
    cancelRequestedAt: spec.cancelRequestedAt,
  });
  if (spec.status === 'succeeded') {
    await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'xlsx' });
  }
  return report.id;
}
