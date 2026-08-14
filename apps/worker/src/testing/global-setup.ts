/** vitest `globalSetup` for the worker's tests. */

import { setup as setUpDatabase } from '@gbd/db/testing';
import { setup as setUpBlobStore } from '@gbd/storage/testing';

export async function setup(): Promise<void> {
  await setUpDatabase();
  await setUpBlobStore();
}
