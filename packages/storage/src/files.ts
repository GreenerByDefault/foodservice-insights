/** Writing one of this product's files, and describing it the way its database row will.
 *
 * `objects.ts` is generic S3 with no product knowledge; this file and `keys.ts` know what a report
 * is. Neither touches the database — the row belongs in the caller's transaction.
 *
 * **Store the object before inserting the row.** The other order can leave a row pointing at
 * nothing, which every reader would have to defend against. This order can leak an unreferenced
 * object, which [`REQUIREMENTS.md`](../../../REQUIREMENTS.md#out-of-scope) already accepts.
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
  CSV_CONTENT_TYPE,
  inputFileKey,
  REJECTED_UPLOAD_CONTENT_TYPE,
  RESULT_FILE_FORMATS,
  rejectedUploadKey,
  resultFileKey,
} from './keys.ts';
import { putObject } from './objects.ts';

/** What a stored file's database row needs to know about it.
 *
 * The field names are `input_file`'s and `result_file`'s columns, so a caller spreads this into its
 * insert alongside the columns only it knows. One function producing both the object and its
 * description is what stops the two disagreeing.
 *
 * `rejected_upload` is the exception: it records only the key, size and filename, under
 * `input_file_*` names.
 */
export type StoredFile = {
  storageKey: string;
  byteSize: number;
  contentType: string;

  /** The 32 bytes both tables check for. A `Uint8Array` rather than a `Buffer` to keep anything
   * Node-specific out of this type; `pg` takes any typed-array view for a `bytea`.
   */
  checksumSha256: Uint8Array;
};

export async function putInputFile(
  store: BlobStore,
  ids: { organizationId: OrganizationId; reportId: ReportId; inputFileId: InputFileId },
  body: Uint8Array,
): Promise<StoredFile> {
  return await storeFile(store, inputFileKey(ids), body, CSV_CONTENT_TYPE);
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
  return await storeFile(store, rejectedUploadKey(ids), body, REJECTED_UPLOAD_CONTENT_TYPE);
}

/** Write `body` to `key`, and report what its row should say about it.
 *
 * Private, so a key and the content type it is served with always come from the same place — a
 * public version taking both would let a caller store a `.csv` as a PDF.
 */
async function storeFile(
  store: BlobStore,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<StoredFile> {
  await putObject(store, key, body, { contentType });
  return { storageKey: key, ...describeFile(body, contentType) };
}

/** Everything about a file that can be worked out from its bytes alone.
 *
 * Takes bytes and never a string: `byte_size` has to be the encoded length, which `body.length` on
 * a string silently is not for any non-ASCII input.
 *
 * *Rejected: also sending S3's `ChecksumSHA256` header.* The SDK already sends a CRC32 of every
 * upload, and whether Supabase Storage verifies a supplied digest is unconfirmed.
 */
function describeFile(body: Uint8Array, contentType: string): Omit<StoredFile, 'storageKey'> {
  return {
    byteSize: body.byteLength,
    contentType,
    // Copied out of the `Buffer` `digest()` returns, so the value is the plain `Uint8Array` the
    // type promises — a `Buffer` would satisfy the type but serialise as something else.
    checksumSha256: Uint8Array.from(createHash('sha256').update(body).digest()),
  };
}
