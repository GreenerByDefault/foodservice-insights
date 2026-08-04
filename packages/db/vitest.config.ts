import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    expect: { requireAssertions: true },
    // Migrates the test database before anything runs. `TEST_DB=1` comes from the
    // `test:unit` script, which is what points this at the test stack rather than dev.
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
