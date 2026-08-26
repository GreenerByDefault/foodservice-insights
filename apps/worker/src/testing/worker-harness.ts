/** The scaffolding [`worker.test.ts`](../worker.test.ts) drives: a worker wired to a report
 * fixture, and the helpers every test uses to seed, release, and observe it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MINUTE_MS, SECOND_MS } from '@gbd/core';
import type { AnalysisAttemptId, DatabaseExecutor } from '@gbd/db';
import { type Breakable, readAnalysisAttemptRow } from '@gbd/db/testing';
import { type RecordingEmailer, recordingEmailer } from '@gbd/email/testing';
import {
  type BlobStore,
  deletePrefix,
  listObjectKeys,
  organizationPrefix,
  putObject,
} from '@gbd/storage';
import { BLOB_STORE } from '@gbd/storage/env';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { SYSTEM_CLOCK } from '../clock.ts';
import {
  createWorkerConfig,
  MAX_RENEWAL_ROUND_TRIP_MS,
  type WorkerConfig,
  type WorkerDefaultableFields,
} from '../config.ts';
import { WORKER_DATABASE } from '../db.ts';
import { createWorker, type Worker } from '../worker.ts';
import { type ReportFixture, type SeededReport, withReportFixture } from './attempt-fixture.ts';
import { aWorkerId } from './attempt-helpers.ts';
import { manualClock } from './clock.ts';
import { type FakeChildStep, fakeChildCommand, releaseFakeChild } from './fake-child.ts';
import { waitUntil } from './wait-until.ts';

/** Fast wherever a real timer is involved, generous wherever the manual clock is what moves. */
export const TEST_CONFIG: WorkerDefaultableFields = {
  maxConcurrentAttempts: 2,
  queuePollIntervalMs: 10,
  directIntervalMs: 50,
  killAfterNoProgressMs: 60 * SECOND_MS,
  killAfterTotalRuntimeMs: 120 * SECOND_MS,
  killGraceMs: 200,
  drainGraceMs: 500,
  leaseExpiresAfterMs: MAX_RENEWAL_ROUND_TRIP_MS + 1 * SECOND_MS,
  claimedCeilingMs: 10 * MINUTE_MS,
  reapIntervalMs: 50,
  uploadRetryBudgetMs: 5 * SECOND_MS,
  notifyIntervalMs: 50,
};

/** Succeeds the moment it is spawned. */
export const SUCCEEDING_STEPS: readonly FakeChildStep[] = [
  { step: 'result' },
  { step: 'exit', code: 0 },
];

/** Holds until the test releases it, then succeeds. */
export const HOLDING_STEPS: readonly FakeChildStep[] = [
  { step: 'waitFor', sentinel: 'go' },
  ...SUCCEEDING_STEPS,
];

/** Writes `result.json` and *then* holds, so a test can break a dependency across the settle. */
export const SUCCEEDING_ON_RELEASE_STEPS: readonly FakeChildStep[] = [
  { step: 'result' },
  { step: 'waitFor', sentinel: 'go' },
  { step: 'exit', code: 0 },
];

export type WorkerOptions = {
  steps?: readonly FakeChildStep[];
  overrides?: WorkerDefaultableFields;
  db?: DatabaseExecutor;
  store?: BlobStore;
  /** Real time instead of a `ManualClock`, for the tests that let `drain()` sleep. */
  systemClock?: boolean;
};

export type Harness = {
  worker: Worker;
  workerId: string;
  config: WorkerConfig;
  emails: RecordingEmailer;
  /** Every report this worker will claim from, `reports[0]` being the fixture's own. */
  reports: readonly SeededReport[];
  advance(milliseconds: number): void;
  /** A second worker over the same queue, report, and run root, drained with the first. */
  anotherWorker(options?: WorkerOptions): Harness;
};

/** One worker over `reports` reports of one organization.
 *
 * More than one report is what it takes to have more than one attempt in flight — a report may
 * only have one non-terminal attempt at a time.
 */
export async function withWorker<T>(
  options: WorkerOptions & { reports?: number },
  body: (harness: Harness, fixture: ReportFixture) => Promise<T>,
): Promise<T> {
  return await withReportFixture(async (fixture) => {
    const drains: (() => Promise<void>)[] = [];
    const reports: SeededReport[] = [fixture];
    for (let index = 1; index < (options.reports ?? 1); index++) {
      reports.push(await fixture.seedReport());
    }

    function build(workerOptions: WorkerOptions): Harness {
      const workerId = aWorkerId();
      const manual = workerOptions.systemClock === true ? undefined : manualClock();
      const emails = recordingEmailer();
      const config = createWorkerConfig(
        {
          workerId,
          runRoot: fixture.runRoot,
          childCommand: fakeChildCommand(workerOptions.steps ?? SUCCEEDING_STEPS),
        },
        { ...TEST_CONFIG, ...workerOptions.overrides },
      );
      const worker = createWorker({
        db: workerOptions.db ?? WORKER_DATABASE,
        store: workerOptions.store ?? BLOB_STORE,
        emailer: emails.service,
        clock: manual ?? SYSTEM_CLOCK,
        config,
        candidateReports: reports.map((report) => report.reportId),
      });

      drains.push(async () => {
        // Advanced *after* the drain has started, so the graceful phase sees its own deadline
        // already past: a manual clock would otherwise never reach a deadline `drain()` is really
        // sleeping towards, and cleanup would tick until the test timed out.
        const draining = worker.drain();
        manual?.advance(config.drainGraceMs);
        await draining;
      });

      return {
        worker,
        workerId,
        config,
        emails,
        reports,
        advance(milliseconds) {
          if (manual === undefined) {
            throw new Error('worker.test: this worker runs on the system clock');
          }
          manual.advance(milliseconds);
        },
        anotherWorker: (nested = {}) => build(nested),
      };
    }

    const harness = build(options);
    try {
      return await body(harness, fixture);
    } finally {
      // Kills whatever is still running, so no fake child outlives its run root.
      for (const drain of drains) await drain();
    }
  });
}

export function runDirectory(fixture: ReportFixture, attemptId: AnalysisAttemptId): string {
  return join(fixture.runRoot, attemptId);
}

export async function release(
  fixture: ReportFixture,
  attemptId: AnalysisAttemptId,
  sentinel = 'go',
): Promise<void> {
  await releaseFakeChild(runDirectory(fixture, attemptId), sentinel);
}

/** Break the store, release the child, and wait for its verdict to park at upload. */
export async function parkAtUpload(
  fixture: ReportFixture,
  store: Breakable<BlobStore>,
  attemptId: AnalysisAttemptId,
): Promise<void> {
  store.break();
  await release(fixture, attemptId);
  await waitUntil(
    () => !existsSync(runDirectory(fixture, attemptId)),
    'the upload fails and the verdict parks',
  );
}

/** Break the database, release the child, and wait for its verdict to park at record. */
export async function parkAtRecord(
  fixture: ReportFixture,
  database: Breakable<DatabaseExecutor>,
  attemptId: AnalysisAttemptId,
): Promise<void> {
  database.break();
  await release(fixture, attemptId);
  await waitUntil(
    () => !existsSync(runDirectory(fixture, attemptId)),
    'the terminal write fails and the verdict parks',
  );
}

export function attemptRow(attemptId: AnalysisAttemptId) {
  return readAnalysisAttemptRow(WORKER_DATABASE, attemptId);
}

export async function resultFileRows(attemptId: AnalysisAttemptId) {
  return await WORKER_DATABASE.selectFrom('resultFile')
    .selectAll()
    .where('analysisAttemptId', '=', attemptId)
    .execute();
}

/** Every object an attempt has uploaded. The fixture's input files are not under this prefix, so
 * this is exactly what the code under test has written. */
export async function uploadedKeys(fixture: ReportFixture): Promise<string[]> {
  return await listObjectKeys(BLOB_STORE, organizationPrefix(fixture.organizationId));
}

/** Tick until the database shows what the tick was supposed to bring about.
 *
 * A resume is launched by a tick and deliberately never awaited by it, so "tick once and assert" is
 * only ever a race. Ticking until the row moves is not.
 */
export async function directUntil(
  worker: Worker,
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  await waitUntil(async () => {
    await worker.direct();
    return await condition();
  }, description);
}

export async function statusIs(attemptId: AnalysisAttemptId, status: string): Promise<boolean> {
  return (await attemptRow(attemptId)).status === status;
}

export async function requestCancel(attemptId: AnalysisAttemptId): Promise<void> {
  await WORKER_DATABASE.updateTable('analysisAttempt')
    .set({ cancelRequestedAt: sql<Date>`now()` })
    .where('id', '=', attemptId)
    .execute();
}

export async function deleteInputObject(fixture: ReportFixture): Promise<void> {
  await deletePrefix(BLOB_STORE, fixture.inputCsvStorageKey);
}

export async function restoreInputObject(fixture: ReportFixture): Promise<void> {
  await putObject(BLOB_STORE, fixture.inputCsvStorageKey, fixture.inputCsv);
}

/** Seed one attempt on `harness.reports[report]` and claim it through the worker itself. Claims are
 * oldest-first, so starting them in order is what makes which attempt is which deterministic. */
export async function startOne(harness: Harness, report = 0): Promise<AnalysisAttemptId> {
  const attemptId = await reportAt(harness, report).seedAttempt();
  expect(await harness.worker.claimAndStart()).toBe('started');
  return attemptId;
}

export function reportAt(harness: Harness, index: number): SeededReport {
  const report = harness.reports[index];
  if (report === undefined) throw new Error(`worker.test: no report seeded at ${index}`);
  return report;
}
