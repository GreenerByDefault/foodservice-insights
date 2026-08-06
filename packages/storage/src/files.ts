/** Writing one of this product's files, and describing it the way its database row will.
 *
 * The split against `objects.ts`: that file is generic S3 with no product knowledge, whereas this
 * one and `keys.ts` know what a report is. Nothing here touches the database — the row belongs in
 * the caller's transaction, which this package knows nothing about.
 *
 * **Store the object before inserting the row.** The other order writes a row pointing at nothing
 * if the upload then fails, which every reader would have to defend against; this order leaks an
 * unreferenced object if the transaction rolls back, which nothing has to defend against.
 * [`REQUIREMENTS.md`](../../../REQUIREMENTS.md#out-of-scope) already accepts orphaned objects.
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
 * The field names are `input_file`'s and `result_file`'s column names, so a caller can spread this
 * straight into an insert alongside the columns only it knows — `report_id`, `original_filename`,
 * `kind`. That is the point of returning it: one function produces both the object and the
 * description of it, so the two cannot disagree about size, type, or contents.
 *
 * `rejected_upload` is the exception. It records only the key, the size, and the filename, under
 * `input_file_*` names, so it uses two of these four fields and writes them out by hand.
 */
export type StoredFile = {
  storageKey: string;
  byteSize: number;
  contentType: string;

  /** A `Uint8Array` rather than a `Buffer` so that nothing Node-specific leaks into this type;
   * `pg` accepts any typed-array view for a `bytea` column. Always the 32 bytes that
   * `input_file` and `result_file` both check for.
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
 * Private, and reached only through the three functions above, so that a key and the content type
 * it is served with always come from the same place. A public version taking both would let a
 * caller store a `.csv` as a PDF.
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
 * Pure, and separate from the write, so the description is testable without a blob store — and so
 * that checking a file we read back against its recorded checksum later needs no new code.
 *
 * Takes only bytes, never a string: `byte_size` has to be the encoded length, and `body.length` on
 * a string silently differs from it for any non-ASCII input.
 *
 * *Rejected: also sending S3's `ChecksumSHA256` header.* The SDK already sends a CRC32 of every
 * upload, and the digest recorded here is the durable check; a header whose verification by
 * Supabase Storage we have not confirmed would look like integrity without being it.
 */
function describeFile(body: Uint8Array, contentType: string): Omit<StoredFile, 'storageKey'> {
  return {
    byteSize: body.byteLength,
    contentType,
    // Copied out of the `Buffer` that `digest()` returns, so the value really is the plain
    // `Uint8Array` the type promises. A `Buffer` would satisfy the type while still serialising
    // and comparing as something else — 32 bytes is nothing to copy for that.
    checksumSha256: Uint8Array.from(createHash('sha256').update(body).digest()),
  };
}
