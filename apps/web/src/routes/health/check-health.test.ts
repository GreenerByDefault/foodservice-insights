import { divideByZero, withRollback } from '@gbd/db/testing';
import { initializeBlobStore, shutdownBlobStore } from '@gbd/storage';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { requireVar } from '$lib/server/env';
import { blobStore } from '$lib/server/storage';
import { _checkHealth } from './+server.ts';

describe('_checkHealth', () => {
  test('ok when both the database and the bucket are reachable', async () => {
    await withRollback(database(), async (transaction) => {
      expect(await _checkHealth(transaction, blobStore())).toEqual({ status: 'ok' });
    });
  });

  test('degraded when the database is unreachable', async () => {
    await withRollback(database(), async (transaction) => {
      // The point here is what `divideByZero` leaves behind: an aborted transaction, so
      // `_checkHealth`'s own `SELECT 1` fails too.
      await divideByZero(transaction).catch(() => {});

      expect(await _checkHealth(transaction, blobStore())).toEqual({ status: 'degraded' });
    });
  });

  test('degraded when the bucket does not exist', async () => {
    // Same endpoint and credentials as blobStore(), pointed at a bucket that was never created.
    const missingBucket = initializeBlobStore({
      endpoint: requireVar('S3_ENDPOINT'),
      region: requireVar('S3_REGION'),
      accessKeyId: requireVar('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireVar('S3_SECRET_ACCESS_KEY'),
      bucket: `nonexistent-${crypto.randomUUID()}`,
    });

    try {
      await withRollback(database(), async (transaction) => {
        expect(await _checkHealth(transaction, missingBucket)).toEqual({ status: 'degraded' });
      });
    } finally {
      shutdownBlobStore(missingBucket);
    }
  });
});
