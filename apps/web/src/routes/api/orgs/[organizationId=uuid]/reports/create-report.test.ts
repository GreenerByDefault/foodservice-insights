import type { RejectedUploadReason, ReportId } from '@gbd/db';
import { getObject } from '@gbd/storage';
import { describe, expect, test } from 'vitest';
import { MAX_UPLOAD_BYTES } from '$lib/reports/limits';
import { FIELD } from '$lib/reports/metadata';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { _createReport } from './+server.ts';

const RAW_CSV = 'product,date ordered,weight\nbeef mince,2026-01-05,12\n';
const NORMALIZED_CSV = 'product,date,weight\nbeef mince,2026-01-05,12\n';

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
    file: new File([RAW_CSV], 'procurement.csv', { type: 'text/csv' }),
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
        deletedByUserId: null,
      });

      const inputFile = await transaction
        .selectFrom('inputFile')
        .selectAll()
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(inputFile).toMatchObject({
        originalFilename: 'procurement.csv',
        contentType: 'text/csv',
        byteSize: NORMALIZED_CSV.length,
        isModified: true,
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
        claimedAt: null,
        leaseRenewedAt: null,
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
      // The row points at the normalized variant; the file as uploaded is kept beside it.
      expect(new TextDecoder().decode(bytes)).toBe(NORMALIZED_CSV);
      // The column is CHECKed at 32 bytes, so a wrong-shaped digest would never have inserted.
      expect(Buffer.from(inputFile.checksumSha256 as Uint8Array)).toHaveLength(32);

      // Deleting an organization is one prefix delete.
      expect(inputFile.storageKey.startsWith(`org/${organizationId}/`)).toBe(true);
    });
  });
});

describe('a rejected upload', () => {
  async function reject(overrides: SubmissionOverrides) {
    return await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(overrides),
      );
      const refusal = { status: response.status, body: await response.json() };

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

      return { refusal, recorded, bytes, reports };
    });
  }

  test.for([
    ['an empty file', { file: new File([], 'empty.csv', { type: 'text/csv' }) }, 'empty'],
    ['a counts basis outside the enum', { countsBasis: 'guesses' }, 'invalid_metadata'],
    ['monthly counts that are not JSON', { monthlyCounts: '{oops' }, 'invalid_metadata'],
    ['no file at all', { file: null }, 'other'],
  ] as const)('answers 400 and records %s', async ([, overrides, reason]) => {
    const { refusal, recorded, reports } = await reject(overrides);

    expect(refusal).toMatchObject({ status: 400 });
    expect(recorded).toMatchObject({ rejectionReason: reason satisfies RejectedUploadReason });
    expect(reports).toEqual([]);
  });

  test('answers with the summary, and nothing else', async () => {
    const { refusal } = await reject({ monthlyCounts: '{oops' });

    // `toEqual`, not `toMatchObject`: the point here is the keys that are absent.
    expect(refusal.body).toEqual({ summary: expect.any(String) });
  });

  test('keeps the file that was refused', async () => {
    const { recorded, bytes } = await reject({ countsBasis: 'guesses' });

    expect(recorded).toMatchObject({
      inputFileOriginalFilename: 'procurement.csv',
      inputFileByteSize: RAW_CSV.length,
    });
    expect(new TextDecoder().decode(bytes)).toBe(RAW_CSV);
  });

  test('records the metadata exactly as it was submitted', async () => {
    const { recorded } = await reject({ countsBasis: 'guesses', siteName: 'Main dining hall' });

    expect(recorded).toMatchObject({
      reportName: 'Q1 procurement',
      reportSiteName: 'Main dining hall',
      reportCountsBasis: 'guesses',
      reportUnitSystem: 'lb',
      reportMonthlyCounts: JSON.stringify({ '2026-01': 120, '2026-02': 135 }),
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

  test('keeps monthly counts that are not JSON', async () => {
    const { recorded } = await reject({ monthlyCounts: '{oops' });

    expect(recorded).toMatchObject({ reportMonthlyCounts: '{oops' });
    expect(recorded?.rejectionDetail).toContain('not valid JSON');
  });

  test('records an oversized file without storing its bytes', async () => {
    const oversized = new File(['x'.repeat(MAX_UPLOAD_BYTES + 1)], 'big.csv', {
      type: 'text/csv',
    });

    const { refusal, recorded } = await reject({ file: oversized });

    expect(refusal).toMatchObject({ status: 400 });
    expect(recorded).toMatchObject({
      rejectionReason: 'too_large',
      inputFileOriginalFilename: 'big.csv',
      inputFileByteSize: MAX_UPLOAD_BYTES + 1,
      inputFileStorageKey: null,
    });
  });
});
