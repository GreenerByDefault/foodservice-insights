import { afterAll, beforeEach, vi } from 'vitest';
import { getRequestEvent } from '$app/server';
import { closeDatabase } from '../db.ts';
import { closeBlobStore } from '../storage.ts';
import { SERVER_LOGS } from './logs.ts';

// pino writes to fd 1, past vitest's `silent: 'passed-only'`, so no test may reach the real root.
vi.mock('../root-log.ts', async () => {
  const { SERVER_LOGS } = await import('./logs.ts');
  return { rootLogger: () => SERVER_LOGS.log };
});

// Tests call hooks and handlers directly, outside any request, so the real one throws and
// `logger()` falls back to the root. A test of a request's own lines points this at its event.
vi.mock('$app/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('$app/server')>();
  return { ...original, getRequestEvent: vi.fn(original.getRequestEvent) };
});

beforeEach(() => {
  SERVER_LOGS.clear();
  vi.mocked(getRequestEvent).mockReset();
});

afterAll(async () => {
  await Promise.all([closeDatabase(), closeBlobStore()]);
});
