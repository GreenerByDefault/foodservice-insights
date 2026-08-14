import { afterAll } from 'vitest';
import { shutdown } from '../env.ts';

afterAll(async () => {
  await shutdown();
});
