/** A report real enough for a worker test to claim and start attempts against: a committed
 * organization/report/input file, a real object at the input file's storage key, and a run root
 * of its own.
 *
 * Committed, not rolled back — `withRollback` cannot be used here at all. The worker holds its own
 * pooled connections, so rows written inside a test's rolled-back transaction would be invisible
 * to code under test that reads through the pool directly, and the test would pass vacuously.
 */

import { createHash } from 'node:crypto';
import type { AnalysisAttemptId, OrganizationId, ReportId, UserId } from '@gbd/db';
import { DATABASE } from '@gbd/db/env';
import {
  insertAnalysisAttempt,
  insertFixtureOrganization,
  insertInputFile,
  insertReport,
  withCommittedFixture,
} from '@gbd/db/testing';
import { deletePrefix, organizationPrefix, putObject } from '@gbd/storage';
import { BLOB_STORE } from '@gbd/storage/env';
import { claimNextAttempt } from '../attempt/queue.ts';
import { withTemporaryRunRoot } from './run-root.ts';

/** One report with a real input object behind it, and its own attempt sequence. */
export type SeededReport = {
  reportId: ReportId;
  /** The input file's storage key, so a test can delete the object out from under an attempt to
   * exercise `MissingInputFileError`. */
  inputCsvStorageKey: string;
  /** Insert another pending attempt on this report, with the next `attemptNumber`. */
  seedAttempt(): Promise<AnalysisAttemptId>;
};

export type ReportFixture = SeededReport & {
  organizationId: OrganizationId;
  /** The requester of every seeded attempt, so a notify sweep has somewhere to send. */
  requester: { id: UserId; email: string };
  inputCsv: Uint8Array;
  runRoot: string;
  /** Another report on the same organization, committed the same way.
   *
   * `analysis_attempt_one_open_per_report` allows a report only one non-terminal attempt at a time,
   * so a test that needs two attempts in flight at once needs two reports.
   */
  seedReport(): Promise<SeededReport>;
};

/** A single claimed attempt. */
export type AttemptFixture = Omit<ReportFixture, 'requester' | 'seedAttempt' | 'seedReport'> & {
  attemptId: AnalysisAttemptId;
};

const AN_INPUT_CSV = Buffer.from('filler bytes');
const AN_INPUT_CSV_SHA256 = createHash('sha256').update(AN_INPUT_CSV).digest();

/** Commit an organization with one report and one input file; write the input file's bytes to the
 * real object its storage key names; hand the test a run root of its own, a `seedAttempt` to insert
 * pending attempts against the report one at a time, and a `seedReport` for when one report is not
 * enough. Torn down however the test ends, including the objects any code under test writes under
 * the organization's prefix.
 */
export async function withReportFixture<T>(
  body: (fixture: ReportFixture) => Promise<T>,
): Promise<T> {
  return await withTemporaryRunRoot(
    async (runRoot) =>
      await withCommittedFixture(
        DATABASE,
        async (transaction, trash) => {
          const { organization, admin } = await insertFixtureOrganization(transaction, trash);
          const { email } = await transaction
            .selectFrom('auth.users')
            .select('email')
            .where('id', '=', admin.id)
            .executeTakeFirstOrThrow();
          const report = await insertReport(transaction, { organizationId: organization.id });
          const inputFile = await insertInputFile(transaction, {
            reportId: report.id,
            object: { byteSize: AN_INPUT_CSV.byteLength, checksumSha256: AN_INPUT_CSV_SHA256 },
          });
          return {
            organizationId: organization.id,
            reportId: report.id,
            requester: { id: admin.id, email: email as string },
            storageKey: inputFile.storageKey,
          };
        },
        async (setUp) => {
          const requester = setUp.requester;
          try {
            return await body({
              ...(await seededReport(setUp.reportId, setUp.storageKey, requester.id)),
              organizationId: setUp.organizationId,
              requester,
              inputCsv: AN_INPUT_CSV,
              runRoot,
              seedReport: () => anotherReport(setUp.organizationId, requester.id),
            });
          } finally {
            await deletePrefix(BLOB_STORE, organizationPrefix(setUp.organizationId));
          }
        },
      ),
  );
}

/** Write the report's input object, and hand back its own attempt sequence. */
async function seededReport(
  reportId: ReportId,
  storageKey: string,
  requesterId: UserId,
): Promise<SeededReport> {
  await putObject(BLOB_STORE, storageKey, AN_INPUT_CSV);
  let attemptNumber = 0;
  return {
    reportId,
    inputCsvStorageKey: storageKey,
    seedAttempt: async () => {
      attemptNumber += 1;
      const attempt = await insertAnalysisAttempt(DATABASE, {
        reportId,
        attemptNumber,
        requestedByUserId: requesterId,
      });
      return attempt.id;
    },
  };
}

/** Committed through `DATABASE` rather than the set-up transaction, for the same reason the whole
 * fixture is committed: the worker reads through its own pool. Teardown needs nothing extra —
 * deleting the organization cascades to its reports, and the objects are under its prefix.
 */
async function anotherReport(
  organizationId: OrganizationId,
  requesterId: UserId,
): Promise<SeededReport> {
  const report = await insertReport(DATABASE, { organizationId });
  const inputFile = await insertInputFile(DATABASE, {
    reportId: report.id,
    object: { byteSize: AN_INPUT_CSV.byteLength, checksumSha256: AN_INPUT_CSV_SHA256 },
  });
  return await seededReport(report.id, inputFile.storageKey, requesterId);
}

/** A `ReportFixture` with one attempt already seeded and claimed by `workerId`. */
export async function withAttemptFixture<T>(
  workerId: string,
  body: (fixture: AttemptFixture) => Promise<T>,
): Promise<T> {
  return await withReportFixture(async (fixture) => {
    const seededAttemptId = await fixture.seedAttempt();
    const attemptId = await claimNextAttempt(DATABASE, workerId, {
      candidateReports: [fixture.reportId],
    });
    if (attemptId === undefined) {
      throw new Error('attempt-fixture: the fixture attempt was not claimable');
    }
    if (attemptId !== seededAttemptId) {
      throw new Error('attempt-fixture: claimed an attempt other than the one just seeded');
    }

    return await body({
      attemptId,
      organizationId: fixture.organizationId,
      reportId: fixture.reportId,
      inputCsv: fixture.inputCsv,
      inputCsvStorageKey: fixture.inputCsvStorageKey,
      runRoot: fixture.runRoot,
    });
  });
}
