import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type { BlobStore } from './client.ts';
import { asBlobStoreError, isBucketAlreadyExistsError } from './errors.ts';
import { deletePrefix } from './objects.ts';

/** Create the store's bucket, unless it already exists.
 *
 * Safe to call concurrently.
 *
 * Supabase Storage creates a private bucket, per our requirements.
 */
export async function ensureBucket(store: BlobStore): Promise<void> {
  try {
    await store.client.send(new CreateBucketCommand({ Bucket: store.bucket }));
  } catch (cause) {
    if (isBucketAlreadyExistsError(cause)) return;
    throw asBlobStoreError('CreateBucket', cause);
  }
}

/** Delete every object in the store's bucket, keeping the bucket, and report how many went. */
export async function emptyBucket(store: BlobStore): Promise<number> {
  // An empty prefix matches every key.
  return await deletePrefix(store, '');
}
