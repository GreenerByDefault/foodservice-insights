/** vitest `globalSetup` for the worker's tests. Both are needed: `attempt-lifecycle.test.ts` claims real
 * rows and uploads to a real bucket, so both stores have to exist before any test file runs. */

import { setup as setUpDatabase } from '@gbd/db/testing';
import { setup as setUpBlobStore } from '@gbd/storage/testing';

export async function setup(): Promise<void> {
  await setUpDatabase();
  await setUpBlobStore();
}
