import { defineConfig } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // vitest owns *.{test,spec}.ts; Playwright owns *.e2e.ts. The two runners must
  // never be able to pick up each other's files.
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  webServer: {
    // Run the real adapter-node output rather than `vite preview`, so e2e
    // exercises the artifact that gets deployed. `turbo run test:e2e` depends on
    // `build`, so build/ exists by the time this runs.
    command: 'node build/index.js',
    env: {
      PORT: String(PORT),
      // adapter-node rejects cross-site form POSTs with 403 unless ORIGIN is set.
      // Nothing posts yet, but it is free to set now and confusing to debug later.
      ORIGIN: BASE_URL
    },
    // `url` waits for a 2xx response; `port` only waits for a listening socket.
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000
  }
});
