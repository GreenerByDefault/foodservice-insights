/** Writing one of this product's files, and describing it the way its database row will.
 *
 * The caller should store the object before inserting the database row to ensure the reference
 * actually exists in the blob store.
 */

import { createHash } from 'node:crypto';
import type {
  AnalysisAttemptId,
  InputFileId,
  OrganizationId,
  RejectedUploadId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';
import type { BlobStore } from './client.ts';
import {
  NORMALIZED_CSV_CONTENT_TYPE,
  normalizedInputFileKey,
  OPAQUE_CSV_CONTENT_TYPE,
  originalInputFileKey,
  RESULT_FILE_FORMATS,
  rejectedUploadKey,
  resultFileKey,
  workbookInputFileKey,
  XLSX_CONTENT_TYPE,
} from './keys.ts';
import { putObject } from './objects.ts';

/** What a stored file's database row needs to know about it. */
export type StoredFile = {
  storageKey: string;
  byteSize: number;
  contentType: string;

  /** The 32 bytes both tables check for. A `Uint8Array` rather than a `Buffer` to keep anything
   * Node-specific out of this type; `pg` takes any typed-array view for a `bytea`.
   */
  checksumSha256: Uint8Array;
};

export type InputFileVariants = {
  original: Uint8Array;
  normalized: Uint8Array;
  /** The original workbook, when the upload was one. Stored under its own key alongside the
   * normalized CSV; the server never opens it — see `putInputFile`'s doc comment. */
  workbook?: Uint8Array;
};

export type StoredInputFile = StoredFile & { isModified: boolean; workbook?: StoredFile };

/** Store an upload's normalized CSV, its original bytes where they differ, and its workbook where
 * there was one — three keys written in parallel, none opened or interpreted here.
 */
export async function putInputFile(
  store: BlobStore,
  ids: { organizationId: OrganizationId; reportId: ReportId; inputFileId: InputFileId },
  variants: InputFileVariants,
): Promise<StoredInputFile> {
  const isModified = Buffer.compare(variants.original, variants.normalized) !== 0;
  const [stored, , workbook] = await Promise.all([
    storeFile(store, normalizedInputFileKey(ids), variants.normalized, NORMALIZED_CSV_CONTENT_TYPE),
    isModified
      ? putObject(store, originalInputFileKey(ids), variants.original, {
          contentType: OPAQUE_CSV_CONTENT_TYPE,
        })
      : Promise.resolve(),
    variants.workbook
      ? storeFile(store, workbookInputFileKey(ids), variants.workbook, XLSX_CONTENT_TYPE)
      : Promise.resolve(undefined),
  ]);
  return { ...stored, isModified, ...(workbook && { workbook }) };
}

export async function putResultFile(
  store: BlobStore,
  ids: {
    organizationId: OrganizationId;
    reportId: ReportId;
    analysisAttemptId: AnalysisAttemptId;
    resultFileId: ResultFileId;
    kind: ResultFileKind;
  },
  body: Uint8Array,
): Promise<StoredFile> {
  return await storeFile(
    store,
    resultFileKey(ids),
    body,
    RESULT_FILE_FORMATS[ids.kind].contentType,
  );
}

export async function putRejectedUpload(
  store: BlobStore,
  ids: { organizationId: OrganizationId; rejectedUploadId: RejectedUploadId },
  body: Uint8Array,
): Promise<StoredFile> {
  return await storeFile(store, rejectedUploadKey(ids), body, OPAQUE_CSV_CONTENT_TYPE);
}

/** Write `body` to `key`. */
async function storeFile(
  store: BlobStore,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<StoredFile> {
  await putObject(store, key, body, { contentType });
  return { storageKey: key, ...describeFile(body, contentType) };
}

/** Everything about a file that can be worked out from its bytes alone. */
function describeFile(body: Uint8Array, contentType: string): Omit<StoredFile, 'storageKey'> {
  return {
    byteSize: body.byteLength,
    contentType,
    // Copied out of the `Buffer` `digest()` returns, so the value is the plain `Uint8Array` the
    // type promises — a `Buffer` would satisfy the type but serialise as something else.
    checksumSha256: Uint8Array.from(createHash('sha256').update(body).digest()),
  };
}
