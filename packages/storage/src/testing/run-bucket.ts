/** A bucket per Playwright run, so two runs never race to overwrite the same object.
 *
 * Blob store objects are the other thing besides the database that a `pnpm test:e2e` run writes,
 * and two runs sharing one bucket (`files`, the default from `.env.test`) can collide on the same
 * keys the way two runs sharing one database collide on the same rows — see
 * `.claude/plans/test-run-isolation.md`. `S3_BUCKET=files-<runId>` per run sidesteps it.
 *
 * **Spiked, not assumed**: Supabase Storage's S3 API accepts `DeleteBucket` — confirmed
 * empirically against the running test stack: it succeeds on an empty bucket and fails with
 * `ResourceNotEmpty` on one that isn't, exactly like real S3. That's what lets `deleteRunBucket`
 * actually remove the bucket rather than fall back to a key prefix within a shared one.
 *
 * A run bucket needs no client of its own — an `S3Client` isn't bucket-scoped, only each request
 * names one — so `createRunBucket` returns a `BlobStore` that reuses the caller's client and only
 * swaps in the run bucket's name.
 */

import { DeleteBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { bucketExists, ensureBucket } from '../buckets.ts';
import type { BlobStore } from '../client.ts';
import { sendOptions } from '../client.ts';
import { asBlobStoreError, isNotFoundError } from '../errors.ts';
import { deletePrefix } from '../objects.ts';

const RUN_BUCKET_PREFIX = 'files-';

/** How long a run bucket may exist before the sweep considers it abandoned — the same bound
 * `sweepStaleRunDatabases` (`@gbd/db/testing`) applies to run databases, since both exist for the
 * lifetime of one Playwright run. */
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface RunBucket {
  readonly name: string;
  /** Reuses `store`'s client; only `bucket` differs. Pass this to whatever the run wires its blob
   * store from — never `store` itself, which still points at the shared bucket. */
  readonly store: BlobStore;
}

/** Create a bucket scoped to one run, and return a store pointed at it.
 *
 * `store` supplies the client and the request-deadline configuration; only its `bucket` is
 * replaced. Safe to call concurrently with another run doing the same — each generates its own
 * name.
 */
export async function createRunBucket(store: BlobStore): Promise<RunBucket> {
  const name = runBucketName();
  const runStore: BlobStore = { ...store, bucket: name };
  await ensureBucket(runStore);
  return { name, store: runStore };
}

function runBucketName(): string {
  return `${RUN_BUCKET_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Empty and delete a run bucket. Safe to call on one that's already gone.
 *
 * Checks existence first rather than letting the empty-then-delete calls fail into that case:
 * `ListObjectsV2` against a missing bucket answers `NoSuchBucket`, a name `isNotFoundError`
 * doesn't recognise — it exists for a missing *key*, which Supabase Storage reports
 * indistinguishably from a missing bucket (see `errors.ts`), not for a missing bucket found by
 * name up front like this.
 */
export async function deleteRunBucket(store: BlobStore): Promise<void> {
  if (!(await bucketExists(store))) return;

  await deletePrefix(store, '');
  try {
    await store.client.send(new DeleteBucketCommand({ Bucket: store.bucket }), sendOptions(store));
  } catch (cause) {
    if (isNotFoundError(cause)) return;
    throw asBlobStoreError('DeleteBucket', cause);
  }
}

/** Drop every run bucket old enough that no still-running test could own it, and report which
 * ones it dropped.
 *
 * Bounded by age alone, unlike `sweepStaleRunDatabases`: a blob store bucket carries no
 * equivalent of `pg_stat_activity` to check for a live user, so age is the only signal available.
 * `RUN_STALE_AFTER_MS` is chosen generously enough that a still-running suite never reaches it.
 */
export async function sweepStaleRunBuckets(store: BlobStore): Promise<string[]> {
  const response = await store.client.send(new ListBucketsCommand({}), sendOptions(store));
  const names = (response.Buckets ?? [])
    .map(({ Name }) => Name)
    .filter((name) => name !== undefined);
  const stale = names.filter(isStale);

  for (const name of stale) {
    await deleteRunBucket({ ...store, bucket: name });
  }
  return stale;
}

function isStale(name: string): boolean {
  if (!name.startsWith(RUN_BUCKET_PREFIX)) return false;
  const createdAt = Number(name.slice(RUN_BUCKET_PREFIX.length).split('-')[0]);
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt > RUN_STALE_AFTER_MS;
}
