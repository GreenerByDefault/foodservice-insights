import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    globalSetup: ['./src/testing/global-setup.ts'],
    setupFiles: ['./src/testing/setup-file.ts'],

    // Supabase Storage can have contention.
    testTimeout: 30_000,
  },
});
