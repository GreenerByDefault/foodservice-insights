import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';
import { bucketExists } from '../buckets.ts';
import { sendOptions } from '../client.ts';
import { BLOB_STORE } from '../env.ts';
import { putObject } from '../objects.ts';
import { createRunBucket, deleteRunBucket, sweepStaleRunBuckets } from './run-bucket.ts';

describe('createRunBucket / deleteRunBucket', () => {
  test('creates a bucket distinct from the shared one, and deleting it removes it entirely', async () => {
    const run = await createRunBucket(BLOB_STORE);
    try {
      expect(run.name).not.toBe(BLOB_STORE.bucket);
      expect(await bucketExists(run.store)).toBe(true);
    } finally {
      await deleteRunBucket(run.store);
    }

    expect(await bucketExists(run.store)).toBe(false);
  });

  test('is safe to call twice', async () => {
    const run = await createRunBucket(BLOB_STORE);
    await deleteRunBucket(run.store);
    await expect(deleteRunBucket(run.store)).resolves.toBeUndefined();
  });

  test('deletes objects left in the bucket before removing it, since Supabase Storage refuses to remove a non-empty one', async () => {
    const run = await createRunBucket(BLOB_STORE);
    await putObject(run.store, 'a-key.txt', 'contents');
    await expect(deleteRunBucket(run.store)).resolves.toBeUndefined();
    expect(await bucketExists(run.store)).toBe(false);
  });
});

describe('sweepStaleRunBuckets', () => {
  // Creates run-shaped buckets directly, rather than through `createRunBucket`, so the "old" one
  // can be backdated without waiting out the real staleness window.
  test('drops an old bucket and spares a young one', async () => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const old = `files-${threeHoursAgo}-oldbckt1`;
    const young = `files-${Date.now()}-young0001`;

    try {
      await BLOB_STORE.client.send(
        new CreateBucketCommand({ Bucket: old }),
        sendOptions(BLOB_STORE),
      );
      await BLOB_STORE.client.send(
        new CreateBucketCommand({ Bucket: young }),
        sendOptions(BLOB_STORE),
      );

      const dropped = await sweepStaleRunBuckets(BLOB_STORE);
      expect(dropped).toContain(old);
      expect(dropped).not.toContain(young);

      await expect(
        BLOB_STORE.client.send(new HeadBucketCommand({ Bucket: old }), sendOptions(BLOB_STORE)),
      ).rejects.toThrow();
      await expect(
        BLOB_STORE.client.send(new HeadBucketCommand({ Bucket: young }), sendOptions(BLOB_STORE)),
      ).resolves.toBeDefined();
    } finally {
      await deleteRunBucket({ ...BLOB_STORE, bucket: young });
    }
  });

  test('never touches the shared bucket, whatever it is named', async () => {
    const dropped = await sweepStaleRunBuckets(BLOB_STORE);
    expect(dropped).not.toContain(BLOB_STORE.bucket);
    expect(await bucketExists(BLOB_STORE)).toBe(true);
  });
});
