import { configDefaults, defineConfig } from 'vitest/config';

const SHARED = { environment: 'node', expect: { requireAssertions: true } } as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...SHARED,
          name: 'unit',
          exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
        },
      },
      {
        test: {
          ...SHARED,
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          globalSetup: ['./src/testing/global-setup.ts'],
        },
      },
    ],
  },
});
