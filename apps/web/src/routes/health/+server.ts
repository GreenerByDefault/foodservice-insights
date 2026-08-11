import type { DatabaseExecutor } from '@gbd/db';
import { type BlobStore, bucketExists } from '@gbd/storage';
import { json } from '@sveltejs/kit';
import { sql } from 'kysely';
import { database } from '$lib/server/db';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

type HealthReport = { status: 'ok' | 'degraded' };

async function checkStorage(store: BlobStore): Promise<void> {
  if (!(await bucketExists(store))) throw new Error(`Bucket "${store.bucket}" does not exist`);
}

/** Liveness probe, including the database and the blob store's bucket.
 *
 * Concurrent, so one slow dependency doesn't add to the other's latency. Reports only
 * `ok`/`degraded` — this route is unauthenticated, so which check failed stays in the log.
 */
export async function _checkHealth(db: DatabaseExecutor, store: BlobStore): Promise<HealthReport> {
  const [dbResult, storageResult] = await Promise.allSettled([
    sql`SELECT 1`.execute(db),
    checkStorage(store),
  ]);

  for (const result of [dbResult, storageResult]) {
    if (result.status === 'rejected') console.error('Health check failed:', result.reason);
  }

  const healthy = dbResult.status === 'fulfilled' && storageResult.status === 'fulfilled';
  return { status: healthy ? 'ok' : 'degraded' };
}

export const GET: RequestHandler = async () => {
  const report = await _checkHealth(database(), blobStore());
  return json(report, { status: report.status === 'ok' ? 200 : 503 });
};
