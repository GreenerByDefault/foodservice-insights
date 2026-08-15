import { afterAll } from 'vitest';
import { closeDatabase } from '../db.ts';
import { closeBlobStore } from '../storage.ts';

afterAll(async () => {
  await Promise.all([closeDatabase(), closeBlobStore()]);
});
