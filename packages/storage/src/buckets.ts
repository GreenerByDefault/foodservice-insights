import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { type BlobStore, sendOptions } from './client.ts';
import { asBlobStoreError, isBucketAlreadyExistsError, isNotFoundError } from './errors.ts';
import { deletePrefix } from './objects.ts';

/** Create the store's bucket, unless it already exists.
 *
 * Safe to call concurrently.
 *
 * Supabase Storage creates a private bucket, per our requirements.
 */
export async function ensureBucket(store: BlobStore): Promise<void> {
  try {
    await store.client.send(new CreateBucketCommand({ Bucket: store.bucket }), sendOptions(store));
  } catch (cause) {
    if (isBucketAlreadyExistsError(cause)) return;
    throw asBlobStoreError('CreateBucket', cause);
  }
}

/** Whether the store's bucket exists.
 *
 * Unlike `headObject`/`getObject`, a `HeadBucket` carries no key, so its 404 can't be ambiguous
 * with a missing key the way theirs is — see `errors.ts`.
 */
export async function bucketExists(store: BlobStore): Promise<boolean> {
  try {
    await store.client.send(new HeadBucketCommand({ Bucket: store.bucket }), sendOptions(store));
    return true;
  } catch (cause) {
    if (isNotFoundError(cause)) return false;
    throw asBlobStoreError('HeadBucket', cause);
  }
}

/** Delete every object in the store's bucket, keeping the bucket, and report how many went. */
export async function emptyBucket(store: BlobStore): Promise<number> {
  // An empty prefix matches every key.
  return await deletePrefix(store, '');
}
