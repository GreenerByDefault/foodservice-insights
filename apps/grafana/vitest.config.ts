import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    // Only print logs for tests that fail.
    silent: 'passed-only',
    // Migrates the test database, so `metrics_reader` exists for `local-metrics-reader.test.ts`.
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
