/** vitest `globalSetup` for the server test project. */

import { setup as setUpDatabase } from '@gbd/db/testing';
import { setup as setUpBlobStore } from '@gbd/storage/testing';

export async function setup(): Promise<void> {
  await Promise.all([setUpDatabase(), setUpBlobStore()]);
}
