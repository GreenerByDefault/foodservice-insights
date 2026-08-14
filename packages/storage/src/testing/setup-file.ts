import { afterAll } from 'vitest';
import { shutdown } from '../env.ts';

afterAll(() => {
  shutdown();
});
