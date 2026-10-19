import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    // Only print logs for tests that fail.
    silent: 'passed-only',
    // Migrates the test database, and prepares a run database and Grafana for the panel check.
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
