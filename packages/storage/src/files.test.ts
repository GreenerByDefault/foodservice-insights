/** The three writes this product performs, against a real Supabase Storage S3 endpoint. */

import { createHash } from 'node:crypto';
import type { AnalysisAttemptId, RejectedUploadId, ReportId } from '@gbd/db';
import { newInputFileId, newResultFileId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { BLOB_STORE } from './env.ts';
import { putInputFile, putRejectedUpload, putResultFile } from './files.ts';
import { organizationPrefix, originalInputFileKey } from './keys.ts';
import { deletePrefix, getObject, headObject, listObjectKeys } from './objects.ts';
import { withTemporaryOrganization } from './testing/organizations.ts';

// Has a non-ASCII name, so that a byte count taken from a string's length rather than its
// encoding would come out short.
const ORIGINAL_CSV = new TextEncoder().encode('product,date,weight\ncafé au lait,2026-01-05,12\n');

// Differs from `ORIGINAL_CSV`, so a test can tell the normalized bytes from the original.
const NORMALIZED_CSV = new TextEncoder().encode(
  'product,date,weight\ncafe au lait,2026-01-05,12\n',
);

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function aReportId(): ReportId {
  return crypto.randomUUID() as ReportId;
}

function anAnalysisAttemptId(): AnalysisAttemptId {
  return crypto.randomUUID() as AnalysisAttemptId;
}

describe('putInputFile', () => {
  test('stores the bytes it was given', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
      );

      expect(await getObject(BLOB_STORE, stored.storageKey)).toEqual(ORIGINAL_CSV);
    });
  });

  // `putInputFile` computes `byteSize` and `contentType` itself rather than trusting the
  // caller, so check them against `headObject`, an independent read of what S3 recorded.
  test('reports metadata matching what the store recorded', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
      );

      expect(await headObject(BLOB_STORE, stored.storageKey)).toMatchObject({
        size: stored.byteSize,
        contentType: stored.contentType,
      });
    });
  });

  test('reports the encoded byte length, not the character count', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
      );

      expect(stored.byteSize).toBe(ORIGINAL_CSV.byteLength);
    });
  });

  // 32 bytes is the only length `input_file`'s and `result_file`'s checksum column accept.
  test('checksums the bytes, in the 32 bytes the column takes', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
      );

      // Wrap the expected digest in `Uint8Array.from`: `createHash().digest()` returns a
      // `Buffer`, which is itself a `Uint8Array` but which `toEqual` treats as unequal to a
      // plain one of the same bytes. This also pins down that `stored.checksumSha256` isn't
      // left as a `Buffer` either.
      expect(stored.checksumSha256).toEqual(
        Uint8Array.from(createHash('sha256').update(ORIGINAL_CSV).digest()),
      );
      expect(stored.checksumSha256.byteLength).toBe(32);
    });
  });

  describe('isModified', () => {
    test('is false for equal buffers, and writes no other object', async () => {
      await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
        const stored = await putInputFile(
          BLOB_STORE,
          { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
          { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
        );

        expect(stored.isModified).toBe(false);
        expect(await listObjectKeys(BLOB_STORE, organizationPrefix(organizationId))).toEqual([
          stored.storageKey,
        ]);
      });
    });

    test('is true for differing buffers, and keeps each at its own key', async () => {
      await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
        const ids = { organizationId, reportId: aReportId(), inputFileId: newInputFileId() };
        const stored = await putInputFile(BLOB_STORE, ids, {
          original: ORIGINAL_CSV,
          normalized: NORMALIZED_CSV,
        });

        expect(stored.isModified).toBe(true);
        expect(await getObject(BLOB_STORE, stored.storageKey)).toEqual(NORMALIZED_CSV);
        expect(await getObject(BLOB_STORE, originalInputFileKey(ids))).toEqual(ORIGINAL_CSV);

        // The byteSize and checksumSha256 are for the normalized CSV, not the input one.
        expect(stored.byteSize).toBe(NORMALIZED_CSV.byteLength);
        expect(stored.checksumSha256).toEqual(
          Uint8Array.from(createHash('sha256').update(NORMALIZED_CSV).digest()),
        );
      });
    });
  });
});

describe('putResultFile', () => {
  test('gives each kind its own storage key', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const location = {
        organizationId,
        reportId: aReportId(),
        analysisAttemptId: anAnalysisAttemptId(),
      };

      const stored = await Promise.all(
        (['pdf', 'xlsx', 'chart'] as const).map(async (kind) =>
          putResultFile(BLOB_STORE, { ...location, resultFileId: newResultFileId(), kind }, PDF),
        ),
      );

      expect(new Set(stored.map(({ storageKey }) => storageKey)).size).toBe(3);
    });
  });

  test('stores each kind under its content type', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const location = {
        organizationId,
        reportId: aReportId(),
        analysisAttemptId: anAnalysisAttemptId(),
      };

      const stored = await Promise.all(
        (['pdf', 'xlsx', 'chart'] as const).map(async (kind) =>
          putResultFile(BLOB_STORE, { ...location, resultFileId: newResultFileId(), kind }, PDF),
        ),
      );

      expect(stored.map(({ contentType }) => contentType)).toEqual([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'image/png',
      ]);

      for (const { storageKey, contentType } of stored) {
        expect(await headObject(BLOB_STORE, storageKey)).toMatchObject({ contentType });
      }
    });
  });
});

describe('putRejectedUpload', () => {
  test('stores the bytes without labelling them CSV', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putRejectedUpload(
        BLOB_STORE,
        { organizationId, rejectedUploadId: crypto.randomUUID() as RejectedUploadId },
        ORIGINAL_CSV,
      );

      expect(stored.contentType).toBe('application/octet-stream');
      expect(await headObject(BLOB_STORE, stored.storageKey)).toMatchObject({
        contentType: 'application/octet-stream',
      });
    });
  });
});

describe('deleting an organization', () => {
  test('removes every kind of file it owns, and nothing another organization owns', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (doomed) => {
      await withTemporaryOrganization(BLOB_STORE, async (kept) => {
        const reportId = aReportId();
        await putRejectedUpload(
          BLOB_STORE,
          { organizationId: doomed, rejectedUploadId: crypto.randomUUID() as RejectedUploadId },
          ORIGINAL_CSV,
        );
        await putInputFile(
          BLOB_STORE,
          { organizationId: doomed, reportId, inputFileId: newInputFileId() },
          { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
        );
        await putResultFile(
          BLOB_STORE,
          {
            organizationId: doomed,
            reportId,
            analysisAttemptId: anAnalysisAttemptId(),
            resultFileId: newResultFileId(),
            kind: 'pdf',
          },
          PDF,
        );
        const survivor = await putInputFile(
          BLOB_STORE,
          { organizationId: kept, reportId: aReportId(), inputFileId: newInputFileId() },
          { original: ORIGINAL_CSV, normalized: ORIGINAL_CSV },
        );

        expect(await deletePrefix(BLOB_STORE, organizationPrefix(doomed))).toBe(3);

        expect(await listObjectKeys(BLOB_STORE, organizationPrefix(doomed))).toEqual([]);
        expect(await listObjectKeys(BLOB_STORE, organizationPrefix(kept))).toEqual([
          survivor.storageKey,
        ]);
      });
    });
  });
});
