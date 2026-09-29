import { collectingLogger } from '@gbd/core/testing';
import { shutdown as shutdownStore } from '@gbd/storage/env';
import { afterAll, vi } from 'vitest';
import { shutdown } from '../db.ts';

// pino writes to fd 1, past vitest's `silent: 'passed-only'`, and `WORKER_DATABASE`'s pool logs
// through the root. Every other logger is a parameter that each test passes itself.
vi.mock('../log.ts', () => ({ WORKER_LOG: collectingLogger().log }));

afterAll(async () => {
  await shutdown();
  shutdownStore();
});
