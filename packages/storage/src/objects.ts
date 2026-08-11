import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { type BlobStore, sendOptions } from './client.ts';
import { asBlobStoreError, BlobStoreError, blobStoreRequest, isNotFoundError } from './errors.ts';

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

/** What may be written alongside an object's bytes.
 *
 * Notably *not* here: the download filename. Supabase Storage silently discards a
 * `Content-Disposition` given to `PutObject` but does honour a `response-content-disposition`
 * override on a read, so the filename goes on the signed URL instead — see `signedObjectUrl`.
 */
export type PutObjectOptions = {
  contentType?: string;
};

/** What a read tells us about one object, without its bytes. */
export type ObjectMetadata = {
  size: number;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
};

/** Shared by every operation that walks a prefix a page at a time. */
export type PagingOptions = {
  /** How many keys to fetch per request.
   *
   * Only worth setting to exercise the paging loop over a handful of objects; S3's ceiling is
   * right for real use.
   */
  pageSize?: number;
};

/** Write an object, replacing whatever was at `key`.
 *
 * Takes only in-memory bodies. A stream would have to arrive with its `ContentLength` already
 * known or go through a multipart upload. `MAX_UPLOAD_BYTES` caps uploads at 10MB, so holding
 * the whole body in memory costs nothing.
 */
export async function putObject(
  store: BlobStore,
  key: string,
  body: ObjectBody,
  options: PutObjectOptions = {},
): Promise<void> {
  await blobStoreRequest('PutObject', () =>
    store.client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
      }),
      sendOptions(store),
    ),
  );
}

/** Read a whole object into memory, or `undefined` if there is nothing at `key`. */
export async function getObject(store: BlobStore, key: string): Promise<Uint8Array | undefined> {
  // Reading the body is part of the same request, not a step after it: `GetObject` answers with a
  // stream, so a connection lost halfway through arrives here rather than from `send`.
  return await undefinedIfMissing('GetObject', async () => {
    const response = await store.client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
      sendOptions(store),
    );
    return await response.Body?.transformToByteArray();
  });
}

/** Read an object's metadata without its bytes, or `undefined` if there is nothing at `key`. */
export async function headObject(
  store: BlobStore,
  key: string,
): Promise<ObjectMetadata | undefined> {
  const response = await undefinedIfMissing('HeadObject', () =>
    store.client.send(
      new HeadObjectCommand({ Bucket: store.bucket, Key: key }),
      sendOptions(store),
    ),
  );
  if (!response) return undefined;

  return {
    size: response.ContentLength ?? 0,
    contentType: response.ContentType,
    etag: response.ETag,
    lastModified: response.LastModified,
  };
}

/** Whether anything is stored at `key`.
 *
 * Signing a download URL does not reach the blob store, so this is how a caller answers "is the
 * object really there" before handing out a link — see `signedObjectUrl`.
 */
export async function objectExists(store: BlobStore, key: string): Promise<boolean> {
  return (await headObject(store, key)) !== undefined;
}

/** Every key that starts with `prefix`. */
export async function listObjectKeys(
  store: BlobStore,
  prefix: string,
  options: PagingOptions = {},
): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of listKeyPages(store, prefix, options)) keys.push(...page);
  return keys;
}

/** Delete every object under `prefix`, and report how many that was. Does nothing when nothing
 * matches.
 *
 * Deletes each listing page as it arrives instead of collecting every key first, so memory is
 * bounded by one request.
 */
export async function deletePrefix(
  store: BlobStore,
  prefix: string,
  options: PagingOptions = {},
): Promise<number> {
  let deleted = 0;

  for await (const page of listKeyPages(store, prefix, options)) {
    await deleteKeys(store, page);
    deleted += page.length;
  }

  return deleted;
}

/** The keys under `prefix`, one listing page at a time.
 *
 * A generator so that the continuation-token loop exists once, and so `deletePrefix` can act on a
 * page without waiting for the whole listing. Yields only non-empty pages, which is what lets its
 * callers skip guarding against a delete that names no keys — S3 rejects those.
 */
async function* listKeyPages(
  store: BlobStore,
  prefix: string,
  options: PagingOptions,
): AsyncGenerator<string[]> {
  let continuationToken: string | undefined;

  do {
    const listing = await blobStoreRequest('ListObjectsV2', () =>
      store.client.send(
        new ListObjectsV2Command({
          Bucket: store.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: options.pageSize ?? MAX_KEYS_PER_REQUEST,
        }),
        sendOptions(store),
      ),
    );

    // S3 does not return an entry without a key; dropping one is still better than asserting.
    const keys = (listing.Contents ?? []).map(({ Key }) => Key).filter((key) => key !== undefined);
    if (keys.length > 0) yield keys;

    continuationToken = listing.NextContinuationToken;
  } while (continuationToken);
}

/** Delete one request's worth of keys, at most `MAX_KEYS_PER_REQUEST` of them. */
async function deleteKeys(store: BlobStore, keys: readonly string[]): Promise<void> {
  const response = await blobStoreRequest('DeleteObjects', () =>
    store.client.send(
      new DeleteObjectsCommand({
        Bucket: store.bucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })) },
      }),
      sendOptions(store),
    ),
  );

  // A per-key failure comes back in the response body instead of throwing, so without this a
  // partial delete would look like a complete one.
  const errors = response.Errors ?? [];
  if (errors.length > 0) {
    const described = errors.map(({ Key, Code, Message }) => `${Key} (${Code}: ${Message})`);
    throw new BlobStoreError(
      `DeleteObjects failed for ${errors.length} object(s): ${described.join(', ')}`,
    );
  }
}

/** Await one request, turning "no such object" into `undefined` instead of a throw.
 *
 * The missing-object check has to happen here, on the error the SDK raised, because
 * `asBlobStoreError` is what everything else becomes.
 */
async function undefinedIfMissing<T>(
  operation: string,
  send: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await send();
  } catch (cause) {
    if (isNotFoundError(cause)) return undefined;
    throw asBlobStoreError(operation, cause);
  }
}
