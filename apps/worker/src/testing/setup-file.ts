import { shutdown as shutdownStore } from '@gbd/storage/env';
import { afterAll } from 'vitest';
import { shutdown } from '../db.ts';

afterAll(async () => {
  await shutdown();
  shutdownStore();
});
