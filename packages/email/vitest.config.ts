import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    // Only print logs for tests that fail.
    silent: 'passed-only',
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
