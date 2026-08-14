import { shutdown } from '@gbd/db/env';
import { shutdown as shutdownStore } from '@gbd/storage/env';
import { afterAll } from 'vitest';

afterAll(async () => {
  await shutdown();
  shutdownStore();
});
