/// <reference types="node" />
import { defineConfig } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // vitest owns *.{test,spec}.ts; Playwright owns *.e2e.ts.
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Eagerly detect flaky tests.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Runs the real adapter-node output, not `vite preview`, so e2e exercises the
    // deployed artifact. `turbo run test:e2e` depends on `build`.
    //
    // These tests commit, so we first clear both the database and the blob store, then bring
    // them up to date with the code. We use `pnpm -r`, rather than the `turbo run` the root scripts
    // use, because Turbo is already running this task.
    //
    // `seed` has to follow the truncate, not the migration: the placeholder identity the app runs
    // as is rows, and truncating deletes them while leaving the migration recorded.
    command:
      'pnpm -r run truncate && pnpm -r run migrate && pnpm -r run seed && ' +
      'node --env-file-if-exists=../../.env.test build/index.js',
    env: {
      PORT: String(PORT),
      // adapter-node rejects cross-site POSTs with 403 unless ORIGIN is set.
      ORIGIN: BASE_URL,
      TEST_DB: '1',
      // adapter-node's own default is 512K, well under the upload cap. Set explicitly here as
      // well as in `.env.test`, so the e2e proves the setting rather than the default.
      BODY_SIZE_LIMIT: '11M',
    },
    // `url` waits for a 2xx response; `port` only waits for a listening socket.
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
