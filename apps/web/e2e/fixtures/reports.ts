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
 * spends the placeholder organization's rate-limit budget (that's what the limit counts against —
 * see `countReportsSince`). The `pending` and `processing` states' *attempt* timestamps are the
 * one exception, and are recent instead — see `recentlyBefore`.
 */

import type { Database, ReportId } from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import {
  insertAnalysisAttempt,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import type { Kysely, Transaction } from 'kysely';

const ANCHOR = new Date('2026-01-15T09:00:00Z');

function after(seconds: number): Date {
  return new Date(ANCHOR.getTime() + seconds * 1000);
}

/** `seconds` before the moment this is called — for the two waiting states, whose screen now
 * renders relative durations (`describeProgress`, `formatElapsed`). Anchoring those to the fixed,
 * far-past `ANCHOR` would render a duration that grows every time the suite runs, drifting a
 * committed screenshot's pixels — see `.claude/plans/report-page.md`'s "Relative timestamps will
 * make the screenshot fixtures drift" follow-up.
 */
function recentlyBefore(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

export type ReportState =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'failed-later-attempt'
  | 'canceled';

/** Snake_case, matching `CHART_KEY_PATTERN` (`apps/worker/src/contract/layout.ts`). */
const CHART_KEYS = [
  'total_spend',
  'avg_order_value',
  'top_products',
  'spend_by_month',
  'spend_by_site',
  'order_frequency',
  'category_breakdown',
  'waste_reduction',
];

async function buildPending(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Riverside Diner — March Produce',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: 'pending',
    createdAt: recentlyBefore(5),
  });
  return report.id;
}

async function buildProcessing(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Harbor Bistro — February Proteins',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: 'processing',
    createdAt: recentlyBefore(90),
    claimedAt: recentlyBefore(20),
  });
  return report.id;
}

async function buildSucceeded(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Lakeside Grill — Q1 Procurement',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  const attempt = await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: 'succeeded',
    createdAt: ANCHOR,
    claimedAt: after(30),
    finishedAt: after(210),
  });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'pdf' });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'xlsx' });
  for (const chartKey of CHART_KEYS) {
    await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'chart', chartKey });
  }
  return report.id;
}

async function buildFailed(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Uptown Deli — January Dairy',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: 'failed',
    createdAt: ANCHOR,
    finishedAt: after(90),
    failureReason: 'child_crashed',
  });
  return report.id;
}

async function buildFailedLaterAttempt(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Sunset Cafe — April Beverages',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  // Attempts 1 and 2 must both be `failed` before attempt 3 may exist at all.
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    attemptNumber: 1,
    status: 'failed',
    createdAt: ANCHOR,
    finishedAt: after(90),
  });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    attemptNumber: 2,
    status: 'failed',
    createdAt: after(3_600),
    finishedAt: after(3_690),
  });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    attemptNumber: 3,
    status: 'failed',
    createdAt: after(7_200),
    finishedAt: after(7_290),
    failureReason: 'unusable_data',
  });
  return report.id;
}

async function buildCanceled(tx: Transaction<Database>): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name: 'Downtown Catering — May Seafood',
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: 'canceled',
    createdAt: ANCHOR,
    cancelRequestedAt: after(50),
  });
  return report.id;
}

const BUILDERS: Record<ReportState, (tx: Transaction<Database>) => Promise<ReportId>> = {
  pending: buildPending,
  processing: buildProcessing,
  succeeded: buildSucceeded,
  failed: buildFailed,
  'failed-later-attempt': buildFailedLaterAttempt,
  canceled: buildCanceled,
};

/** Commit one report in `state`, in the placeholder organization. Returns its id. */
export async function insertReportFixture(
  db: Kysely<Database>,
  state: ReportState,
): Promise<ReportId> {
  return await withTransaction(db, BUILDERS[state]);
}

/** Every fixture report, and everything hanging off it. Cascades handle the children:
 * `input_file`, `analysis_attempt` and `result_file` are all `ON DELETE CASCADE`. */
export async function clearReportFixtures(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('report').where('organizationId', '=', PLACEHOLDER_ORGANIZATION_ID).execute();
}

export function reportUrl(reportId: ReportId): string {
  return `/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/${reportId}`;
}
