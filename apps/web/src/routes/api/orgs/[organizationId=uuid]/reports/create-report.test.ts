import type { RejectedUploadReason, ReportId } from '@gbd/db';
import { insertReport } from '@gbd/db/testing';
import { getObject } from '@gbd/storage';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { HOURLY_REPORT_LIMIT, MAX_UPLOAD_BYTES } from '$lib/reports/limits';
import { FIELD } from '$lib/reports/metadata';
import { lockAndCheckReportRateLimit } from '$lib/server/reports/rate-limit';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { _createReport } from './+server.ts';

// Only `lockAndCheckReportRateLimit` is mocked, and it defaults to the real implementation — a
// test below overrides it for one call to simulate the recheck losing a race that the initial
// check won.
vi.mock('$lib/server/reports/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/reports/rate-limit')>();
  return { ...actual, lockAndCheckReportRateLimit: vi.fn(actual.lockAndCheckReportRateLimit) };
});

beforeEach(() => {
  vi.mocked(lockAndCheckReportRateLimit).mockClear();
});

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

// The weekly report limit uses the same mechanism, which uses the same abstraction as the
// hourly limit. So, testing the hourly limit wiring implies the same wiring works for
// the weekly limit.
describe('the hourly report limit', () => {
  test('still accepts the upload one report under the limit', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      for (let i = 0; i < HOURLY_REPORT_LIMIT - 1; i++) {
        await insertReport(transaction, { organizationId, createdByUserId: adminUserId });
      }

      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );

      expect(response.status).toBe(201);
    });
  });

  test('refuses the upload once the organization has reached the limit, before ever writing the accepted input file', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      // Other members' reports count against the organization too — the admin's own count stays
      // at zero, so this exercises the organization check specifically.
      for (let i = 0; i < HOURLY_REPORT_LIMIT; i++) {
        await insertReport(transaction, { organizationId, createdByUserId: null });
      }

      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );
      const body = (await response.json()) as { summary: string };

      expect(response.status).toBe(429);
      expect(body.summary).toContain('organization');

      const recorded = await transaction
        .selectFrom('rejectedUpload')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(recorded).toMatchObject({
        rejectionReason: 'rate_limited' satisfies RejectedUploadReason,
        reportName: 'Q1 procurement',
        // No storage key: a rate-limited rejection never writes bytes — see
        // `recordRateLimitRejection`'s doc comment.
        inputFileByteSize: RAW_CSV.length,
        inputFileStorageKey: null,
      });

      // Still just the seeded reports at the limit — the refused upload added none.
      const reports = await transaction
        .selectFrom('report')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(Number(reports.count)).toBe(HOURLY_REPORT_LIMIT);
    });
  });

  test('still refuses with 429 when the limit is only hit on the recheck inside the write transaction', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId, adminUserId }) => {
      // The initial check (outside the write transaction) sees room; the recheck (inside it, see
      // `_createReport`'s comment on why it exists) is what actually catches this upload.
      const mocked = vi.mocked(lockAndCheckReportRateLimit);
      mocked.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        scope: 'user',
        window: 'hourly',
        limit: HOURLY_REPORT_LIMIT,
      });

      const response = await _createReport(
        transaction,
        store,
        { organizationId, userId: adminUserId },
        createUploadRequest(),
      );

      expect(response.status).toBe(429);
      expect(mocked).toHaveBeenCalledTimes(2);

      const reports = await transaction
        .selectFrom('report')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .execute();
      expect(reports).toEqual([]);

      const recorded = await transaction
        .selectFrom('rejectedUpload')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow();
      expect(recorded).toMatchObject({
        rejectionReason: 'rate_limited' satisfies RejectedUploadReason,
      });
    });
  });
});
