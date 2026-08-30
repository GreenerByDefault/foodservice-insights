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
 * see `countReportsSince`). The exceptions are the timestamps a screen renders relative to "now"
 * rather than as an absolute date which are recent instead, via `msAgo` (`@gbd/core`).
 */

import { msAgo } from '@gbd/core';
import type { AnalysisFailureReason, Database, ReportId } from '@gbd/db';
import { MAX_ANALYSIS_ATTEMPTS, withTransaction } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import {
  insertAnalysisAttempt,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import type { Kysely, Transaction } from 'kysely';
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
 * `ANCHOR` (see the file header). */
async function insertReportWithInputFile(
  tx: Transaction<Database>,
  name: string,
): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name,
    createdAt: ANCHOR,
  });
  await insertInputFile(tx, { reportId: report.id });
  return report.id;
}

function buildPending(
  name: string,
  queuedForMs: number,
): (tx: Transaction<Database>) => Promise<ReportId> {
  return async (tx) => {
    const reportId = await insertReportWithInputFile(tx, name);
    await insertAnalysisAttempt(tx, {
      reportId,
      status: 'pending',
      createdAt: msAgo(queuedForMs),
    });
    return reportId;
  };
}

function buildProcessing(
  name: string,
  queuedForMs: number,
  analyzingForMs: number,
): (tx: Transaction<Database>) => Promise<ReportId> {
  return async (tx) => {
    const reportId = await insertReportWithInputFile(tx, name);
    await insertAnalysisAttempt(tx, {
      reportId,
      status: 'processing',
      createdAt: msAgo(queuedForMs + analyzingForMs),
      claimedAt: msAgo(analyzingForMs),
    });
    return reportId;
  };
}

async function buildSucceeded(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'Lakeside Grill — Q1 Procurement');
  const attempt = await insertAnalysisAttempt(tx, {
    reportId,
    status: 'succeeded',
    createdAt: ANCHOR,
    claimedAt: after(30),
    finishedAt: after(210),
  });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'pdf' });
  await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'xlsx' });
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

async function buildFailed(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'Uptown Deli — January Dairy');
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
async function buildFailedRetried(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'Bayview Tavern — March Seafood');
  await insertFailedAttempts(tx, reportId, 2, 'child_crashed');
  return reportId;
}

/** At `MAX_ANALYSIS_ATTEMPTS`, with a reason whose own follow-up would otherwise say "retry". */
async function buildFailedAtRetryCap(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'Sunset Cafe — April Beverages');
  await insertFailedAttempts(tx, reportId, MAX_ANALYSIS_ATTEMPTS, 'child_crashed');
  return reportId;
}

async function buildCanceled(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'Downtown Catering — May Seafood');
  await insertAnalysisAttempt(tx, {
    reportId,
    status: 'canceled',
    createdAt: ANCHOR,
    cancelRequestedAt: msAgo(50_000),
  });
  return reportId;
}

const BUILDERS: Record<ReportState, (tx: Transaction<Database>) => Promise<ReportId>> = {
  pending: buildPending('Riverside Diner — March Produce', 5_000),
  'pending-delayed': buildPending(
    'Maple Street Cafe — June Dry Goods',
    QUEUE_WARNING_AFTER_MS + 30_000,
  ),
  processing: buildProcessing('Harbor Bistro — February Proteins', 70_000, 20_000),
  'processing-delayed': buildProcessing(
    'Cedar Point Kitchen — August Meats',
    100_000,
    ANALYSIS_WARNING_AFTER_MS + 100_000,
  ),
  succeeded: buildSucceeded,
  failed: buildFailed,
  'failed-retried': buildFailedRetried,
  'failed-at-retry-cap': buildFailedAtRetryCap,
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
