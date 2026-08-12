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

export type InputFileBytes = { original: Uint8Array; normalized: Uint8Array };

export type StoredInputFile = StoredFile & { isModified: boolean };

export async function putInputFile(
  store: BlobStore,
  ids: { organizationId: OrganizationId; reportId: ReportId; inputFileId: InputFileId },
  bytes: InputFileBytes,
): Promise<StoredInputFile> {
  const isModified = Buffer.compare(bytes.original, bytes.normalized) !== 0;
  const [stored] = await Promise.all([
    storeFile(store, normalizedInputFileKey(ids), bytes.normalized, NORMALIZED_CSV_CONTENT_TYPE),
    isModified
      ? putObject(store, originalInputFileKey(ids), bytes.original, {
          contentType: OPAQUE_CSV_CONTENT_TYPE,
        })
      : Promise.resolve(),
  ]);
  return { ...stored, isModified };
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
