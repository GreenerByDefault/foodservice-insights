import { afterAll, beforeEach, vi } from 'vitest';
import { closeDatabase } from '../db.ts';
import { closeBlobStore } from '../storage.ts';
import { SERVER_LOGS } from './logs.ts';

// pino writes to fd 1, past vitest's `silent: 'passed-only'`, so no test may reach the real root.
vi.mock('../root-log.ts', async () => {
  const { SERVER_LOGS } = await import('./logs.ts');
  return { rootLogger: () => SERVER_LOGS.log };
});

beforeEach(() => {
  SERVER_LOGS.clear();
});

afterAll(async () => {
  await Promise.all([closeDatabase(), closeBlobStore()]);
});
