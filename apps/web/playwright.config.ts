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
    // Reset first, because e2e commits — unlike unit tests, which roll back. Then hand the
    // built server the test stack's connection string: adapter-node reads no `.env` files, and
    // `--env-file-if-exists` leaves anything already in the environment alone, so CI and
    // production can still inject their own.
    command:
      'pnpm --filter @gbd/db run truncate && pnpm --filter @gbd/db run migrate && ' +
      'node --env-file-if-exists=../../.env.test build/index.js',
    env: {
      PORT: String(PORT),
      // adapter-node rejects cross-site POSTs with 403 unless ORIGIN is set.
      ORIGIN: BASE_URL,
      // The `truncate` and `migrate` above must hit the test stack, not dev.
      TEST_DB: '1',
    },
    // `url` waits for a 2xx response; `port` only waits for a listening socket.
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
