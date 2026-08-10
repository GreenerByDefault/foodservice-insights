/** The whole `POST /api/orgs/[organizationId]/reports` handler, driven with the multipart request
 * the form sends.
 *
 * Named without a `+`, which would make SvelteKit treat it as a route file.
 */

import type { RejectedUploadReason, ReportId } from '@gbd/db';
import { getObject } from '@gbd/storage';
import { MAX_UPLOAD_BYTES } from '@gbd/upload';
import { afterAll, describe, expect, test } from 'vitest';
import { FIELD } from '$lib/reports/submission';
import { closeDatabase } from '$lib/server/db';
import { closeBlobStore } from '$lib/server/storage';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { _createReport } from './+server.ts';

afterAll(async () => {
  await Promise.all([closeDatabase(), closeBlobStore()]);
});

const A_CSV = 'product,date ordered,amount ordered\nbeef mince,2026-01-05,12\n';

type SubmissionOverrides = {
  name?: string | null;
  siteName?: string | null;
  countsBasis?: string | null;
  unitSystem?: string | null;
  monthlyCounts?: string | null;
  file?: File | null;
};

/** The multipart request the upload form posts. */
function createUploadRequest(overrides: SubmissionOverrides = {}): Request {
  const fields: Required<SubmissionOverrides> = {
    name: 'Q1 procurement',
    siteName: 'Main dining hall',
    countsBasis: 'people',
    unitSystem: 'lb',
    monthlyCounts: JSON.stringify({ '2026-01': 120, '2026-02': 135 }),
    file: new File([A_CSV], 'procurement.csv', { type: 'text/csv' }),
    ...overrides,
  };

  const form = new FormData();
  for (const [key, value] of Object.entries(FIELD)) {
    const submitted = fields[key as keyof SubmissionOverrides];
    if (submitted !== null) form.set(value, submitted);
  }

  return new Request('http://localhost/api/orgs/x/reports', { method: 'POST', body: form });
}

describe('a valid upload', () => {
  test('answers 201 with the new report', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { reportId: ReportId };
      expect(response.headers.get('location')).toBe(
        `/orgs/${organizationId}/reports/${body.reportId}`,
      );
    });
  });

  test('writes the report, its input file, and an attempt for a worker to claim', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );
      const { reportId } = (await response.json()) as { reportId: ReportId };

      const report = await transaction
        .selectFrom('report')
        .selectAll()
        .where('id', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(report).toMatchObject({
        organizationId,
        createdByUserId: adminUserId,
        name: 'Q1 procurement',
        siteName: 'Main dining hall',
        countsBasis: 'people',
        unitSystem: 'lb',
        monthlyCounts: { '2026-01': 120, '2026-02': 135 },
        deletedAt: null,
      });

      const inputFile = await transaction
        .selectFrom('inputFile')
        .selectAll()
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(inputFile).toMatchObject({
        originalFilename: 'procurement.csv',
        contentType: 'text/csv',
        byteSize: A_CSV.length,
      });

      const attempt = await transaction
        .selectFrom('analysisAttempt')
        .selectAll()
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(attempt).toMatchObject({
        attemptNumber: 1,
        status: 'pending',
        requestedByUserId: adminUserId,
        workerId: null,
        lockedAt: null,
        lastHeartbeatAt: null,
        finishedAt: null,
      });
    });
  });

  test('stores the bytes where the row says they are', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );
      const { reportId } = (await response.json()) as { reportId: ReportId };

      const inputFile = await transaction
        .selectFrom('inputFile')
        .select(['storageKey', 'checksumSha256'])
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();

      const bytes = await getObject(store, inputFile.storageKey);
      expect(new TextDecoder().decode(bytes)).toBe(A_CSV);
      // The column is CHECKed at 32 bytes, so a wrong-shaped digest would never have inserted.
      expect(Buffer.from(inputFile.checksumSha256 as Uint8Array)).toHaveLength(32);

      // Deleting an organization has to be one prefix delete — see `@gbd/storage`'s keys.ts.
      expect(inputFile.storageKey.startsWith(`org/${organizationId}/`)).toBe(true);
    });
  });
});

describe('a rejected upload', () => {
  async function reject(overrides: SubmissionOverrides) {
    return await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const failure = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(overrides),
      ).catch((error: unknown) => error);

      const recorded = await transaction
        .selectFrom('rejectedUpload')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .executeTakeFirst();

      const bytes = recorded?.inputFileStorageKey
        ? await getObject(store, recorded.inputFileStorageKey)
        : undefined;

      const reports = await transaction
        .selectFrom('report')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .execute();

      return { failure, recorded, bytes, reports };
    });
  }

  test.for([
    ['an empty file', { file: new File([], 'empty.csv', { type: 'text/csv' }) }, 'empty'],
    [
      'a file that is really a PDF',
      { file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) },
      'unparseable',
    ],
    ['a counts basis outside the enum', { countsBasis: 'guesses' }, 'invalid_metadata'],
    ['monthly counts that are not JSON', { monthlyCounts: '{oops' }, 'invalid_metadata'],
    ['no file at all', { file: null }, 'other'],
  ] as const)('answers 400 and records %s', async ([, overrides, reason]) => {
    const { failure, recorded, reports } = await reject(overrides);

    // The code the client branches on is the same word the database recorded.
    expect(failure).toMatchObject({ status: 400, body: { code: reason } });
    expect(recorded).toMatchObject({ rejectionReason: reason satisfies RejectedUploadReason });
    expect(reports).toEqual([]);
  });

  test('keeps the file that was refused', async () => {
    const { recorded, bytes } = await reject({
      file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }),
    });

    expect(recorded).toMatchObject({
      inputFileOriginalFilename: 'report.pdf',
      inputFileByteSize: 8,
    });
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7');
  });

  test('records the metadata exactly as it was submitted', async () => {
    const { recorded } = await reject({ countsBasis: 'guesses', siteName: 'Main dining hall' });

    expect(recorded).toMatchObject({
      reportName: 'Q1 procurement',
      reportSiteName: 'Main dining hall',
      reportCountsBasis: 'guesses',
      reportUnitSystem: 'lb',
      reportMonthlyCounts: { '2026-01': 120, '2026-02': 135 },
    });
  });

  test('leaves the file columns null when no file arrived', async () => {
    const { recorded } = await reject({ file: null });

    expect(recorded).toMatchObject({
      inputFileStorageKey: null,
      inputFileByteSize: null,
      inputFileOriginalFilename: null,
    });
  });

  test('drops monthly counts that are not JSON, since the column is jsonb', async () => {
    const { recorded } = await reject({ monthlyCounts: '{oops' });

    expect(recorded).toMatchObject({ reportMonthlyCounts: null });
    expect(recorded?.rejectionDetail).toContain('not valid JSON');
  });

  test('records an oversized file without storing its bytes', async () => {
    const oversized = new File(['x'.repeat(MAX_UPLOAD_BYTES + 1)], 'big.csv', {
      type: 'text/csv',
    });

    const { failure, recorded } = await reject({ file: oversized });

    expect(failure).toMatchObject({ status: 400, body: { code: 'too_large' } });
    expect(recorded).toMatchObject({
      rejectionReason: 'too_large',
      inputFileOriginalFilename: 'big.csv',
      inputFileByteSize: MAX_UPLOAD_BYTES + 1,
      inputFileStorageKey: null,
    });
  });
});
