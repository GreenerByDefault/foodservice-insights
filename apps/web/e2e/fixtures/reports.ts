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
 * rather than as an absolute date which are recent instead, via `dbMsAgo` (`@gbd/db/testing`) —
 * Postgres's own clock, not `msAgo`'s (`@gbd/core`), since that "now" is `ReportPageData.now`,
 * itself Postgres's `now()`; backdating from the JS clock instead drifts against it, most
 * visibly across a host suspend/resume, and can round to the wrong hour or minute.
 */

import { HOUR_MS, SECOND_MS } from '@gbd/core';
import type { AnalysisFailureReason, Database, OrganizationId, ReportId, UserId } from '@gbd/db';
import { MAX_ANALYSIS_ATTEMPTS, withTransaction } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import {
  dbMsAgo,
  insertAnalysisAttempt,
  insertAppUser,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import { type Kysely, sql, type Transaction } from 'kysely';
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
 * the heading's other branches get exercised too, without a screenshot dedicated to each.
 */
async function insertReportWithInputFile(
  tx: Transaction<Database>,
  name: string,
  overrides: { siteName?: string; createdByUserId?: UserId } = {},
): Promise<ReportId> {
  const report = await insertReport(tx, {
    organizationId: PLACEHOLDER_ORGANIZATION_ID,
    name,
    createdAt: ANCHOR,
    siteName: overrides.siteName ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
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
      createdAt: dbMsAgo(queuedForMs),
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
      createdAt: dbMsAgo(queuedForMs + analyzingForMs),
      claimedAt: dbMsAgo(analyzingForMs),
    });
    return reportId;
  };
}

async function buildSucceeded(tx: Transaction<Database>): Promise<ReportId> {
  // The screen most likely to be shown off, so it's the one that carries the full heading.
  const creator = await insertAppUser(tx, { displayName: 'Dana Cook' });
  const reportId = await insertReportWithInputFile(tx, 'Q1 Procurement', {
    siteName: 'Lakeside Grill',
    createdByUserId: creator.id,
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
  // A creator with no display name, so the heading's email-fallback branch gets exercised. A
  // fixed email, not the default random one — this fixture renders into a committed screenshot.
  const creator = await insertAppUser(tx, { email: 'jordan@example.test' });
  const reportId = await insertReportWithInputFile(tx, 'January Dairy', {
    createdByUserId: creator.id,
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
async function buildFailedRetried(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'March Seafood');
  await insertFailedAttempts(tx, reportId, 2, 'child_crashed');
  return reportId;
}

/** At `MAX_ANALYSIS_ATTEMPTS`, with a reason whose own follow-up would otherwise say "retry". */
async function buildFailedAtRetryCap(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'April Beverages');
  await insertFailedAttempts(tx, reportId, MAX_ANALYSIS_ATTEMPTS, 'child_crashed');
  return reportId;
}

async function buildCanceled(tx: Transaction<Database>): Promise<ReportId> {
  const reportId = await insertReportWithInputFile(tx, 'May Seafood');
  const stoppedMsAgo = 2 * HOUR_MS;
  await insertAnalysisAttempt(tx, {
    reportId,
    status: 'canceled',
    createdAt: dbMsAgo(stoppedMsAgo + 45 * SECOND_MS),
    cancelRequestedAt: dbMsAgo(stoppedMsAgo),
  });
  return reportId;
}

const BUILDERS: Record<ReportState, (tx: Transaction<Database>) => Promise<ReportId>> = {
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

/** Commit one report in `state`, in the placeholder organization. Returns its id. */
export async function insertReportFixture(
  db: Kysely<Database>,
  state: ReportState,
): Promise<ReportId> {
  return await withTransaction(db, BUILDERS[state]);
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

export function reportUrl(
  reportId: ReportId,
  organizationId: OrganizationId = PLACEHOLDER_ORGANIZATION_ID,
): string {
  return `/orgs/${organizationId}/reports/${reportId}`;
}
