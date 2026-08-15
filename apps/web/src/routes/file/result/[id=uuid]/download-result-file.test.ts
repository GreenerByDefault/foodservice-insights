import type { ReportId, ResultFileId } from '@gbd/db';
import { newResultFileId } from '@gbd/db';
import { insertAnalysisAttempt, insertReport, insertResultFile } from '@gbd/db/testing';
import { putResultFile } from '@gbd/storage';
import { describe, expect, test } from 'vitest';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { _downloadResultFile } from './+server.ts';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 fake');

describe('_downloadResultFile', () => {
  test('a chart redirects to a URL with no content-disposition, so it renders inline', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId }) => {
      const report = await insertReport(transaction, { organizationId });
      const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
      const resultFileId = newResultFileId();
      const stored = await putResultFile(
        store,
        {
          organizationId,
          reportId: report.id,
          analysisAttemptId: attempt.id,
          resultFileId,
          kind: 'chart',
        },
        PDF_BYTES,
      );
      await transaction
        .insertInto('resultFile')
        .values({
          id: resultFileId,
          analysisAttemptId: attempt.id,
          kind: 'chart',
          chartKey: 'total-spend',
          storageKey: stored.storageKey,
          byteSize: stored.byteSize,
          contentType: stored.contentType,
          checksumSha256: stored.checksumSha256,
        })
        .execute();

      const response = await _downloadResultFile(transaction, store, resultFileId);

      expect(response.status).toBe(302);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const location = response.headers.get('location') ?? '';
      const download = await fetch(location);
      expect(download.ok).toBe(true);
      expect(download.headers.get('content-disposition')).toBeNull();
    });
  });

  test('a PDF redirects to a URL that downloads under a name built from the report', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId }) => {
      const report = await insertReport(transaction, { organizationId, name: 'Q1 procurement' });
      const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
      const resultFileId = newResultFileId();
      const stored = await putResultFile(
        store,
        {
          organizationId,
          reportId: report.id,
          analysisAttemptId: attempt.id,
          resultFileId,
          kind: 'pdf',
        },
        PDF_BYTES,
      );
      await transaction
        .insertInto('resultFile')
        .values({
          id: resultFileId,
          analysisAttemptId: attempt.id,
          kind: 'pdf',
          storageKey: stored.storageKey,
          byteSize: stored.byteSize,
          contentType: stored.contentType,
          checksumSha256: stored.checksumSha256,
        })
        .execute();

      const response = await _downloadResultFile(transaction, store, resultFileId);
      const location = response.headers.get('location') ?? '';
      const download = await fetch(location);

      expect(download.headers.get('content-disposition')).toContain('Q1 procurement.pdf');
    });
  });

  describe('404s for', () => {
    test('a file that does not exist', async () => {
      await withFileFixtures(async ({ transaction, store }) => {
        const missing = crypto.randomUUID() as ResultFileId;

        await expect(_downloadResultFile(transaction, store, missing)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a file whose report was soft-deleted', async () => {
      await withFileFixtures(async ({ transaction, store, organizationId }) => {
        const report = await insertReport(transaction, { organizationId });
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
        const resultFile = await insertResultFile(transaction, { analysisAttemptId: attempt.id });
        await transaction
          .updateTable('report')
          .set({ deletedAt: new Date() })
          .where('id', '=', report.id)
          .execute();

        await expect(_downloadResultFile(transaction, store, resultFile.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a row pointing at an object that is not there', async () => {
      await withFileFixtures(async ({ transaction, store, organizationId }) => {
        const report: { id: ReportId } = await insertReport(transaction, { organizationId });
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
        // A row with a plausible key and nothing behind it, which is what an interrupted worker
        // upload would leave if the object write had failed after the row was written.
        const resultFile = await insertResultFile(transaction, { analysisAttemptId: attempt.id });

        await expect(_downloadResultFile(transaction, store, resultFile.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });
  });
});
