import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { BlobStore } from './client.ts';
import { isNotFoundError } from './errors.ts';

/** The most keys that either `ListObjectsV2` or `DeleteObjects` will accept in one request.
 *
 * One number because S3 sets the same ceiling on both, which is what lets `deletePrefix` hand a
 * whole listing page to a single delete. Passed explicitly rather than left to `ListObjectsV2`'s
 * default, so that the two being equal is an assumption this file states rather than a
 * coincidence it relies on.
 */
const MAX_KEYS_PER_REQUEST = 1000;

/** An object's bytes. Streams are deliberately not accepted — see `putObject`. */
export type ObjectBody = Uint8Array | string;

export type DeletePrefixOptions = {
  /** How many keys to clear per round trip.
   *
   * Only worth setting to exercise the paging loop over a handful of objects; S3's ceiling is
   * right for real use.
   */
  pageSize?: number;
};

/** Write an object, replacing whatever was at `key`.
 *
 * Takes only in-memory bodies. A stream would have to arrive with its `ContentLength` already
 * known or go through a multipart upload. REQUIREMENTS.md caps uploads at 10MB, so holding
 * the whole body in memory costs nothing.
 */
export async function putObject(store: BlobStore, key: string, body: ObjectBody): Promise<void> {
  await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: key, Body: body }));
}

/** Read a whole object into memory, or `undefined` if there is nothing at `key`. */
export async function getObject(store: BlobStore, key: string): Promise<Uint8Array | undefined> {
  try {
    const response = await store.client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    return await response.Body?.transformToByteArray();
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/** Delete every object under `prefix`, and report how many that was. Does nothing when nothing
 * matches.
 *
 * Deletes each listing page as it arrives instead of collecting every key first, so memory is
 * bounded by one request and the paging loop is the only thing that has to be right.
 */
export async function deletePrefix(
  store: BlobStore,
  prefix: string,
  options: DeletePrefixOptions = {},
): Promise<number> {
  let continuationToken: string | undefined;
  let deleted = 0;

  do {
    const listing = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: options.pageSize ?? MAX_KEYS_PER_REQUEST,
      }),
    );

    // S3 does not return an entry without a key; dropping one is still better than asserting.
    const keys = (listing.Contents ?? []).map(({ Key }) => Key).filter((key) => key !== undefined);
    if (keys.length > 0) {
      await deleteKeys(store, keys);
      deleted += keys.length;
    }

    continuationToken = listing.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

/** Delete one request's worth of keys, at most `MAX_KEYS_PER_REQUEST` of them. */
async function deleteKeys(store: BlobStore, keys: readonly string[]): Promise<void> {
  const response = await store.client.send(
    new DeleteObjectsCommand({
      Bucket: store.bucket,
      Delete: { Objects: keys.map((key) => ({ Key: key })) },
    }),
  );

  // A per-key failure comes back in the response body instead of throwing, so without this a
  // partial delete would look like a complete one.
  const errors = response.Errors ?? [];
  if (errors.length > 0) {
    const described = errors.map(({ Key, Code, Message }) => `${Key} (${Code}: ${Message})`);
    throw new Error(`Failed to delete ${errors.length} object(s): ${described.join(', ')}`);
  }
}
