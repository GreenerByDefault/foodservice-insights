/** The three writes this product performs, against a real Supabase Storage S3 endpoint.
 *
 * Unmocked for the reason `objects.test.ts` gives.
 *
 * Deliberately not covered: inserting a `StoredFile` into `input_file`. That would make this
 * package's tests need a migrated database as well as a bucket, and
 * `packages/db/tests/report.test.ts` already covers the columns accepting these values. It lands
 * with the upload route, whose tests run against both.
 */

import { createHash } from 'node:crypto';
import type { AnalysisAttemptId, RejectedUploadId, ReportId } from '@gbd/db';
import { newInputFileId, newResultFileId } from '@gbd/db';
import { afterAll, describe, expect, test } from 'vitest';
import { BLOB_STORE, shutdown } from './env.ts';
import { putInputFile, putRejectedUpload, putResultFile } from './files.ts';
import { organizationPrefix } from './keys.ts';
import { deletePrefix, getObject, headObject, listObjectKeys } from './objects.ts';
import { withTemporaryOrganization } from './testing/organizations.ts';

afterAll(() => {
  shutdown();
});

/** A CSV with a non-ASCII name in it, so that a byte count taken from a string's length rather
 * than its encoding would come out short.
 */
const CSV = new TextEncoder().encode('product,date,amount\ncafé au lait,2026-01-05,12\n');

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
        CSV,
      );

      expect(await getObject(BLOB_STORE, stored.storageKey)).toEqual(CSV);
    });
  });

  // The point of returning a `StoredFile`: the row has to describe the object that now exists,
  // not what the caller believed it was sending.
  test('describes the object the store actually holds', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        CSV,
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
        CSV,
      );

      expect(stored.byteSize).toBe(CSV.byteLength);
    });
  });

  // 32 bytes is the only length `input_file`'s and `result_file`'s checksum column accept.
  test('checksums the bytes, in the 32 bytes the column takes', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (organizationId) => {
      const stored = await putInputFile(
        BLOB_STORE,
        { organizationId, reportId: aReportId(), inputFileId: newInputFileId() },
        CSV,
      );

      // A plain `Uint8Array`, which also pins down that the digest is not left as the `Buffer` it
      // arrives as — a `Buffer` satisfies the type but serialises differently.
      expect(stored.checksumSha256).toEqual(
        Uint8Array.from(createHash('sha256').update(CSV).digest()),
      );
      expect(stored.checksumSha256.byteLength).toBe(32);
    });
  });
});

describe('putResultFile', () => {
  test('gives each kind its own key, served as the type that kind is stored in', async () => {
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
        CSV,
      );

      expect(stored.contentType).toBe('application/octet-stream');
      expect(await headObject(BLOB_STORE, stored.storageKey)).toMatchObject({
        contentType: 'application/octet-stream',
      });
    });
  });
});

/** What REQUIREMENTS.md asks of an admin deleting an organization. The layout exists to make it
 * one call.
 */
describe('deleting an organization', () => {
  test('takes every kind of file it owns, and nothing another organization owns', async () => {
    await withTemporaryOrganization(BLOB_STORE, async (doomed) => {
      await withTemporaryOrganization(BLOB_STORE, async (kept) => {
        const reportId = aReportId();
        await putRejectedUpload(
          BLOB_STORE,
          { organizationId: doomed, rejectedUploadId: crypto.randomUUID() as RejectedUploadId },
          CSV,
        );
        await putInputFile(
          BLOB_STORE,
          { organizationId: doomed, reportId, inputFileId: newInputFileId() },
          CSV,
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
          CSV,
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
