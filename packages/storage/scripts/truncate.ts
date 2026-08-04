/** Delete every object, keeping the bucket. `TEST_DB=1` targets the test stack.
 *
 *   pnpm truncate
 *   TEST_DB=1 pnpm truncate
 */

import { emptyBucket, ensureBucket } from '../src/buckets.ts';
import { BLOB_STORE, shutdown } from '../src/env.ts';

try {
  // Truncating leaves the container behind, the way the database's truncate keeps its schema.
  // Creating it when it is absent is what lets this run in any order against a fresh stack.
  await ensureBucket(BLOB_STORE);
  const deleted = await emptyBucket(BLOB_STORE);
  console.log(deleted === 0 ? 'nothing to truncate' : `deleted ${deleted} object(s)`);
} finally {
  shutdown();
}
