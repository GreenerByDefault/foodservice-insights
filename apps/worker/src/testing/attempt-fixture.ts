/** A claimed attempt real enough for `attempt/lifecycle.test.ts` to run `startAttempt`/`settleAttempt`
 * against: a committed organization/report/input file, a real object at the input file's storage
 * key, and a run root of its own.
 *
 * Committed, not rolled back — `withRollback` cannot be used here at all. The worker holds its own
 * pooled connections, so rows written inside a test's rolled-back transaction would be invisible
 * to code under test that reads through the pool directly, and the test would pass vacuously.
 */

import type { AnalysisAttemptId, OrganizationId, ReportId } from '@gbd/db';
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

export type AttemptFixture = {
  attemptId: AnalysisAttemptId;
  organizationId: OrganizationId;
  reportId: ReportId;
  inputCsv: Uint8Array;
  /** The input file's storage key, so a test can delete the object out from under the attempt to
   * exercise `MissingInputFileError`. */
  inputCsvStorageKey: string;
  runRoot: string;
};

const AN_INPUT_CSV = Buffer.from('filler bytes');

/** Commit an organization with one report, one input file, and one pending attempt already
 * claimed by `workerId`; write the input file's bytes to the real object its storage key names;
 * hand the test a run root of its own. Torn down however the test ends, including the objects
 * `startAttempt`/`settleAttempt` themselves write under the organization's prefix.
 */
export async function withAttemptFixture<T>(
  workerId: string,
  body: (fixture: AttemptFixture) => Promise<T>,
): Promise<T> {
  return await withTemporaryRunRoot(
    async (runRoot) =>
      await withCommittedFixture(
        DATABASE,
        async (transaction, trash) => {
          const { organization } = await insertFixtureOrganization(transaction, trash);
          const report = await insertReport(transaction, { organizationId: organization.id });
          const inputFile = await insertInputFile(transaction, { reportId: report.id });
          await insertAnalysisAttempt(transaction, { reportId: report.id });
          return {
            organizationId: organization.id,
            reportId: report.id,
            storageKey: inputFile.storageKey,
          };
        },
        async (setUp) => {
          const attemptId = await claimNextAttempt(DATABASE, workerId, {
            candidateReports: [setUp.reportId],
          });
          if (attemptId === undefined) {
            throw new Error('attempt-fixture: the fixture attempt was not claimable');
          }

          await putObject(BLOB_STORE, setUp.storageKey, AN_INPUT_CSV);
          try {
            return await body({
              attemptId,
              organizationId: setUp.organizationId,
              reportId: setUp.reportId,
              inputCsv: AN_INPUT_CSV,
              inputCsvStorageKey: setUp.storageKey,
              runRoot,
            });
          } finally {
            await deletePrefix(BLOB_STORE, organizationPrefix(setUp.organizationId));
          }
        },
      ),
  );
}
