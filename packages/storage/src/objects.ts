import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { BlobStore } from './client.ts';
import { isNotFoundError } from './errors.ts';

/** S3 rejects a delete naming more keys than this in one request. */
const MAX_KEYS_PER_DELETE = 1000;

/** What may be written alongside an object's bytes. */
export type PutObjectOptions = {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
};

/** An object's bytes. Streams are deliberately not accepted — see `putObject`. */
export type ObjectBody = Uint8Array | string;

/** What a read tells us about one object. */
export type ObjectMetadata = {
  size: number;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
};

/** One entry in a listing. */
export type ObjectSummary = {
  key: string;
  size: number;
  etag: string | undefined;
  lastModified: Date | undefined;
};

export type ListObjectsOptions = {
  /** How many keys to fetch per request.
   *
   * Only worth setting to exercise pagination over a handful of objects; S3's own default of
   * 1000 is right for real use.
   */
  pageSize?: number;
};

/** Write an object, replacing whatever was at `key`.
 *
 * Takes only in-memory bodies. A stream would have to arrive with its `ContentLength` already
 * known or go through a multipart upload, and REQUIREMENTS.md caps uploads at 10MB, so holding
 * the whole body in memory costs nothing.
 * *Rejected: streaming uploads, because they buy nothing at a 10MB cap.*
 */
export async function putObject(
  store: BlobStore,
  key: string,
  body: ObjectBody,
  options: PutObjectOptions = {},
): Promise<void> {
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: key,
      Body: body,
      ContentType: options.contentType,
      CacheControl: options.cacheControl,
      Metadata: options.metadata,
    }),
  );
}

/** Read a whole object into memory, or `undefined` if there is nothing at `key`. */
export async function getObject(store: BlobStore, key: string): Promise<Uint8Array | undefined> {
  const response = await undefinedIfMissing(
    store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key })),
  );
  return await response?.Body?.transformToByteArray();
}

/** Open an object as a stream, or `undefined` if there is nothing at `key`.
 *
 * A web `ReadableStream` rather than a Node one, so it can be handed straight to `Response`
 * and streamed to the client without buffering the object on the server.
 */
export async function getObjectStream(
  store: BlobStore,
  key: string,
): Promise<ReadableStream | undefined> {
  const response = await undefinedIfMissing(
    store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key })),
  );
  return response?.Body?.transformToWebStream();
}

/** Read an object's metadata without its bytes, or `undefined` if there is nothing at `key`. */
export async function headObject(
  store: BlobStore,
  key: string,
): Promise<ObjectMetadata | undefined> {
  const response = await undefinedIfMissing(
    store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key })),
  );
  if (!response) return undefined;

  return {
    size: response.ContentLength ?? 0,
    contentType: response.ContentType,
    etag: response.ETag,
    lastModified: response.LastModified,
  };
}

/** Whether anything is stored at `key`. */
export async function objectExists(store: BlobStore, key: string): Promise<boolean> {
  return (await headObject(store, key)) !== undefined;
}

/** Delete an object. Succeeds whether or not it was there, as S3's own delete does. */
export async function deleteObject(store: BlobStore, key: string): Promise<void> {
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }));
}

/** Delete many objects, in as few requests as S3's per-request limit allows. */
export async function deleteObjects(store: BlobStore, keys: readonly string[]): Promise<void> {
  // S3 rejects a delete that names no keys, and callers reach here with none routinely — a
  // prefix with nothing under it, say.
  if (keys.length === 0) return;

  for (const batch of chunk(keys, MAX_KEYS_PER_DELETE)) {
    const response = await store.client.send(
      new DeleteObjectsCommand({
        Bucket: store.bucket,
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );

    // A per-key failure comes back in the response body instead of throwing, so without this
    // a partial delete would look like a complete one.
    const errors = response.Errors ?? [];
    if (errors.length > 0) {
      const described = errors.map(({ Key, Code, Message }) => `${Key} (${Code}: ${Message})`);
      throw new Error(`Failed to delete ${errors.length} object(s): ${described.join(', ')}`);
    }
  }
}

/** Every object whose key starts with `prefix`, fetched a page at a time.
 *
 * A generator so that callers are not holding every key at once, and so the paging is in one
 * place rather than repeated at each call site.
 */
export async function* listObjects(
  store: BlobStore,
  prefix: string,
  options: ListObjectsOptions = {},
): AsyncGenerator<ObjectSummary> {
  let continuationToken: string | undefined;

  do {
    const response = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: options.pageSize,
      }),
    );

    for (const object of response.Contents ?? []) {
      // S3 does not return an entry without a key; skipping is still better than asserting.
      if (!object.Key) continue;
      yield {
        key: object.Key,
        size: object.Size ?? 0,
        etag: object.ETag,
        lastModified: object.LastModified,
      };
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

/** Just the keys under `prefix`. */
export async function listObjectKeys(
  store: BlobStore,
  prefix: string,
  options: ListObjectsOptions = {},
): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of listObjects(store, prefix, options)) keys.push(object.key);
  return keys;
}

/** Delete every object under `prefix`, and report how many that was. Does nothing when nothing
 * matches.
 *
 * This is the primitive that makes deleting one organization's files a single call — see the
 * key layout in this package's README.
 */
export async function deletePrefix(store: BlobStore, prefix: string): Promise<number> {
  const keys = await listObjectKeys(store, prefix);
  await deleteObjects(store, keys);
  return keys.length;
}

/** Split `items` into runs of at most `size`.
 *
 * Not exported from the package's entry point; it is here, and tested, because the boundary
 * against S3's 1000-key limit is worth pinning without uploading 1001 objects.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** Await a command, turning "no such object" into `undefined` instead of a throw.
 *
 * Takes the promise rather than a thunk: the command is already in flight, and there is
 * nothing to retry here.
 */
async function undefinedIfMissing<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}
