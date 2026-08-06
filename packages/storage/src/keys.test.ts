/** The key layout, asserted as exact strings.
 *
 * Changing one of these is changing where a file lives — a decision about objects already in the
 * bucket, not a test to update.
 *
 * Pure, so this file needs no blob store and no bucket.
 */

import type {
  AnalysisAttemptId,
  InputFileId,
  OrganizationId,
  RejectedUploadId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';
import { describe, expect, test } from 'vitest';
import {
  inputFileKey,
  organizationPrefix,
  RESULT_FILE_FORMATS,
  rejectedUploadKey,
  resultFileKey,
} from './keys.ts';

// Readable stand-ins for real ids, so a golden string shows which id landed in which segment.
const ORGANIZATION_ID = 'organization-1' as OrganizationId;
const REPORT_ID = 'report-1' as ReportId;
const INPUT_FILE_ID = 'input-file-1' as InputFileId;
const ANALYSIS_ATTEMPT_ID = 'analysis-attempt-1' as AnalysisAttemptId;
const RESULT_FILE_ID = 'result-file-1' as ResultFileId;
const REJECTED_UPLOAD_ID = 'rejected-upload-1' as RejectedUploadId;

/** Every kind of key, so the rules that must hold across all of them can be stated once. */
const EVERY_KEY: ReadonlyArray<[string, string]> = [
  [
    'rejected upload',
    rejectedUploadKey({ organizationId: ORGANIZATION_ID, rejectedUploadId: REJECTED_UPLOAD_ID }),
  ],
  [
    'input file',
    inputFileKey({
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      inputFileId: INPUT_FILE_ID,
    }),
  ],
  [
    'result file',
    resultFileKey({
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      analysisAttemptId: ANALYSIS_ATTEMPT_ID,
      resultFileId: RESULT_FILE_ID,
      kind: 'pdf',
    }),
  ],
];

describe('the layout', () => {
  test('puts a rejected upload directly under its organization', () => {
    expect(
      rejectedUploadKey({
        organizationId: ORGANIZATION_ID,
        rejectedUploadId: REJECTED_UPLOAD_ID,
      }),
    ).toBe('org/organization-1/rejected-upload/rejected-upload-1.csv');
  });

  test('puts an input file under its report', () => {
    expect(
      inputFileKey({
        organizationId: ORGANIZATION_ID,
        reportId: REPORT_ID,
        inputFileId: INPUT_FILE_ID,
      }),
    ).toBe('org/organization-1/report/report-1/input/input-file-1.csv');
  });

  test('puts a result file under the attempt that produced it', () => {
    expect(
      resultFileKey({
        organizationId: ORGANIZATION_ID,
        reportId: REPORT_ID,
        analysisAttemptId: ANALYSIS_ATTEMPT_ID,
        resultFileId: RESULT_FILE_ID,
        kind: 'pdf',
      }),
    ).toBe(
      'org/organization-1/report/report-1/analysis-attempt/analysis-attempt-1/result/result-file-1.pdf',
    );
  });

  test.each(Object.keys(RESULT_FILE_FORMATS) as ResultFileKind[])(
    'ends a %s result file with the extension its format is stored under',
    (kind) => {
      expect(
        resultFileKey({
          organizationId: ORGANIZATION_ID,
          reportId: REPORT_ID,
          analysisAttemptId: ANALYSIS_ATTEMPT_ID,
          resultFileId: RESULT_FILE_ID,
          kind,
        }),
      ).toBe(
        `org/organization-1/report/report-1/analysis-attempt/analysis-attempt-1/result/result-file-1.${RESULT_FILE_FORMATS[kind].extension}`,
      );
    },
  );
});

describe('the organization prefix', () => {
  // The rule that makes deleting an organization one `deletePrefix`. `organizationScoped` enforces
  // it; this checks that every builder still goes through it.
  test.each(EVERY_KEY)('covers the %s key', (_description, key) => {
    expect(key.startsWith(organizationPrefix(ORGANIZATION_ID))).toBe(true);
  });

  test('ends in a slash, so it can only match whole segments', () => {
    expect(organizationPrefix(ORGANIZATION_ID)).toBe('org/organization-1/');
  });
});

// A leading or doubled slash is legal in S3, and creates an object at a key nobody will look for.
describe('every key', () => {
  test.each(EVERY_KEY)('%s has no empty path segment', (_description, key) => {
    expect(key.split('/').filter((segment) => segment === '')).toEqual([]);
  });
});
