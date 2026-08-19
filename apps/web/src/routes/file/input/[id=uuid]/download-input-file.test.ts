import type { InputFileId, ReportId } from '@gbd/db';
import { newInputFileId } from '@gbd/db';
import { insertInputFile, insertReport } from '@gbd/db/testing';
import { putInputFile } from '@gbd/storage';
import { describe, expect, test } from 'vitest';
import { withFileFixtures } from '$lib/server/tests/fixtures';
import { _downloadInputFile } from './+server.ts';

const CSV = new TextEncoder().encode('product name,date ordered,weight\n');

describe('_downloadInputFile', () => {
  test('redirects to a URL that actually serves the bytes', async () => {
    await withFileFixtures(async ({ transaction, store, organizationId }) => {
      const report = await insertReport(transaction, { organizationId });
      const inputFileId = newInputFileId();
      const stored = await putInputFile(
        store,
        { organizationId, reportId: report.id, inputFileId },
        { original: CSV, normalized: CSV },
      );
      await transaction
        .insertInto('inputFile')
        .values({
          id: inputFileId,
          reportId: report.id,
          storageKey: stored.storageKey,
          byteSize: stored.byteSize,
          contentType: stored.contentType,
          originalFilename: 'procurement.csv',
          checksumSha256: stored.checksumSha256,
          isModified: stored.isModified,
        })
        .execute();

      const response = await _downloadInputFile(transaction, store, inputFileId);

      expect(response.status).toBe(302);
      expect(response.headers.get('cache-control')).toBe('no-store');

      // The end of the chain: following the signed URL returns what we stored. Nothing else in
      // the suite proves signing works against a real blob store.
      const location = response.headers.get('location') ?? '';
      const download = await fetch(location);
      expect(download.ok).toBe(true);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(CSV);
      expect(download.headers.get('content-disposition')).toContain('procurement.csv');
    });
  });

  describe('404s for', () => {
    test('a file that does not exist', async () => {
      await withFileFixtures(async ({ transaction, store }) => {
        const missing = crypto.randomUUID() as InputFileId;

        await expect(_downloadInputFile(transaction, store, missing)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a file whose report was soft-deleted', async () => {
      await withFileFixtures(async ({ transaction, store, organizationId }) => {
        const report = await insertReport(transaction, { organizationId });
        const inputFile = await insertInputFile(transaction, { reportId: report.id });
        await transaction
          .updateTable('report')
          .set({ deletedAt: new Date() })
          .where('id', '=', report.id)
          .execute();

        await expect(_downloadInputFile(transaction, store, inputFile.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    test('a row pointing at an object that is not there', async () => {
      await withFileFixtures(async ({ transaction, store, organizationId }) => {
        const report: { id: ReportId } = await insertReport(transaction, { organizationId });
        // A row with a plausible key and nothing behind it, which is what an interrupted upload
        // would leave if the object write had failed after the row was written.
        const inputFile = await insertInputFile(transaction, { reportId: report.id });

        await expect(_downloadInputFile(transaction, store, inputFile.id)).rejects.toMatchObject({
          status: 404,
        });
      });
    });
  });
});
