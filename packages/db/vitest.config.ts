import { configDefaults, defineConfig } from 'vitest/config';

const SHARED = { environment: 'node', expect: { requireAssertions: true } } as const;

export default defineConfig({
  test: {
    /** Only `*.integration.test.ts` gets the database. Most of this package needs one, but
     * `uuid.ts` and `errors.ts` are pure and shouldn't have to wait for Docker.
     *
     * `configDefaults.exclude` has to be spread back in: an `exclude` of our own *replaces*
     * vitest's, and the default is what keeps it out of `node_modules` and `dist`.
     */
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
