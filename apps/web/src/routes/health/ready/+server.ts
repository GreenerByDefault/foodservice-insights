import type { DatabaseExecutor } from '@gbd/db';
import { type BlobStore, bucketExists } from '@gbd/storage';
import { sql } from 'kysely';
import { database } from '#lib/server/db.js';
import { logger } from '#lib/server/log.js';
import { blobStore } from '#lib/server/storage.js';
import type { RequestHandler } from './$types';

type ReadinessReport = { status: 'ok' | 'degraded' };

async function checkStorage(store: BlobStore): Promise<void> {
  if (!(await bucketExists(store))) throw new Error(`Bucket "${store.bucket}" does not exist`);
}

/** Readiness probe: can this instance reach the database and the blob store's bucket? The host
 * routes no traffic to an instance that fails it, and fails a deploy whose instances never pass it,
 * so it must never be the liveness probe — a Supabase blip would restart every instance at once.
 *
 * Concurrent, so one slow dependency doesn't add to the other's latency. Reports only
 * `ok`/`degraded` — this route is unauthenticated, so which check failed stays in the log.
 */
export async function _checkReadiness(
  db: DatabaseExecutor,
  store: BlobStore,
): Promise<ReadinessReport> {
  const [dbResult, storageResult] = await Promise.allSettled([
    sql`SELECT 1`.execute(db),
    checkStorage(store),
  ]);

  for (const result of [dbResult, storageResult]) {
    if (result.status === 'rejected')
      logger().error({ err: result.reason }, 'Readiness check failed');
  }

  const healthy = dbResult.status === 'fulfilled' && storageResult.status === 'fulfilled';
  return { status: healthy ? 'ok' : 'degraded' };
}

export const GET: RequestHandler = async () => {
  const report = await _checkReadiness(database(), blobStore());
  return Response.json(report, { status: report.status === 'ok' ? 200 : 503 });
};
