import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    globalSetup: ['./src/testing/global-setup.ts'],

    // Riding out a store that browns out for a few seconds is now a request the client is
    // *supposed* to survive (`retryDelayBaseMs` waits up to ~15.5s across retries); the default
    // 5s would turn that survival into a timeout failure.
    testTimeout: 30_000,
  },
});
