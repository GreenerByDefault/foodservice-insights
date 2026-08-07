/** The whole `POST /api/reports` handler, driven with the multipart request the form sends.
 *
 * Named without a `+`, which would make SvelteKit treat it as a route file.
 */

import type { RejectedUploadReason, ReportId } from '@gbd/db';
import { getObject } from '@gbd/storage';
import { afterAll, describe, expect, test } from 'vitest';
import { MAX_INPUT_FILE_BYTES } from '$lib/reports/limits';
import { closeDatabase } from '$lib/server/db';
import { closeBlobStore } from '$lib/server/storage';
import { aCsv, createUploadRequest, withReportFixtures } from '$lib/server/tests/fixtures';
import { _createReport } from './+server.ts';

afterAll(async () => {
  await Promise.all([closeDatabase(), closeBlobStore()]);
});

describe('a valid upload', () => {
  test('answers 201 with the new report', async () => {
    await withReportFixtures(async ({ transaction, store, session }) => {
      const response = await _createReport(transaction, store, session, createUploadRequest());

      expect(response.status).toBe(201);
      const body = (await response.json()) as { reportId: ReportId };
      expect(response.headers.get('location')).toBe(`/reports/${body.reportId}`);
    });
  });

  test('writes the report, its input file, and an attempt for a worker to claim', async () => {
    await withReportFixtures(async ({ transaction, store, session }) => {
      const response = await _createReport(transaction, store, session, createUploadRequest());
      const { reportId } = (await response.json()) as { reportId: ReportId };

      const report = await transaction
        .selectFrom('report')
        .selectAll()
        .where('id', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(report).toMatchObject({
        organizationId: session.organization.id,
        createdByUserId: session.userId,
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
      });
      expect(inputFile.byteSize).toBe(aCsv().length);

      // The attempt a worker claims. Unclaimed, numbered 1, and attributed to the uploader.
      const attempt = await transaction
        .selectFrom('analysisAttempt')
        .selectAll()
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(attempt).toMatchObject({
        attemptNumber: 1,
        status: 'pending',
        requestedByUserId: session.userId,
        workerId: null,
        lockedAt: null,
        lastHeartbeatAt: null,
        finishedAt: null,
      });
    });
  });

  test('stores the bytes where the row says they are', async () => {
    await withReportFixtures(async ({ transaction, store, session }) => {
      const response = await _createReport(transaction, store, session, createUploadRequest());
      const { reportId } = (await response.json()) as { reportId: ReportId };

      const inputFile = await transaction
        .selectFrom('inputFile')
        .select(['storageKey', 'checksumSha256'])
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();

      const bytes = await getObject(store, inputFile.storageKey);
      expect(new TextDecoder().decode(bytes)).toBe(aCsv());
      // The column is CHECKed at 32 bytes, so a wrong-shaped digest would never have inserted.
      expect(Buffer.from(inputFile.checksumSha256 as Uint8Array)).toHaveLength(32);
    });
  });

  test('files the object under the organization that owns the report', async () => {
    await withReportFixtures(async ({ transaction, store, session }) => {
      const response = await _createReport(transaction, store, session, createUploadRequest());
      const { reportId } = (await response.json()) as { reportId: ReportId };

      const { storageKey } = await transaction
        .selectFrom('inputFile')
        .select('storageKey')
        .where('reportId', '=', reportId)
        .executeTakeFirstOrThrow();

      // Deleting an organization has to be one prefix delete — see `@gbd/storage`'s keys.ts.
      expect(storageKey.startsWith(`org/${session.organization.id}/`)).toBe(true);
    });
  });
});

describe('a rejected upload', () => {
  async function reject(overrides: Parameters<typeof createUploadRequest>[0]) {
    return await withReportFixtures(async ({ transaction, store, session }) => {
      const failure = await _createReport(
        transaction,
        store,
        session,
        createUploadRequest(overrides),
      ).catch((error: unknown) => error);

      const recorded = await transaction
        .selectFrom('rejectedUpload')
        .selectAll()
        .where('organizationId', '=', session.organization.id)
        .executeTakeFirst();

      const bytes = recorded?.inputFileStorageKey
        ? await getObject(store, recorded.inputFileStorageKey)
        : undefined;

      return { failure, recorded, bytes, session };
    });
  }

  test.for([
    ['an empty file', { file: new File([], 'empty.csv', { type: 'text/csv' }) }, 'empty'],
    [
      'a file that is not a CSV',
      { file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) },
      'other',
    ],
    ['a counts basis outside the enum', { countsBasis: 'guesses' }, 'invalid_metadata'],
    ['monthly counts that are not JSON', { monthlyCounts: '{oops' }, 'invalid_metadata'],
    ['no file at all', { file: null }, 'other'],
  ] as const)('answers 400 and records %s', async ([, overrides, reason]) => {
    const { failure, recorded } = await reject(overrides);

    // The code the client branches on is the same word the database recorded.
    expect(failure).toMatchObject({ status: 400, body: { code: reason } });
    expect(recorded).toMatchObject({ rejectionReason: reason satisfies RejectedUploadReason });
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

  test('writes no report', async () => {
    await withReportFixtures(async ({ transaction, store, session }) => {
      await _createReport(transaction, store, session, createUploadRequest({ file: null })).catch(
        () => undefined,
      );

      const reports = await transaction
        .selectFrom('report')
        .selectAll()
        .where('organizationId', '=', session.organization.id)
        .execute();
      expect(reports).toEqual([]);
    });
  });

  test('answers 400 for a file over the size cap', async () => {
    // Larger than the product limit but well under `BODY_SIZE_LIMIT`, which would otherwise
    // reject this before any handler ran.
    const oversized = aCsv(MAX_INPUT_FILE_BYTES + 1024);

    const { failure, recorded } = await reject({
      file: new File([oversized], 'big.csv', { type: 'text/csv' }),
    });

    expect(failure).toMatchObject({ status: 400, body: { code: 'too_large' } });
    expect(recorded).toMatchObject({ rejectionReason: 'too_large' });
  });
});
