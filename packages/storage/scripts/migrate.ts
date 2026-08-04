/** Bring the blob store up to date with the code. `TEST_DB=1` targets the test stack.
 *
 *   pnpm migrate
 *   TEST_DB=1 pnpm migrate
 *
 * Today that is only creating the bucket. It shares a command with the database's migrations
 * because an app missing either one is equally broken.
 */

import { ensureBucket } from '../src/buckets.ts';
import { BLOB_STORE, shutdown } from '../src/env.ts';

try {
  await ensureBucket(BLOB_STORE);
  console.log(`bucket '${BLOB_STORE.bucket}' is ready`);
} finally {
  shutdown();
}
