import { configDefaults, defineConfig } from 'vitest/config';

const SHARED = { environment: 'node', expect: { requireAssertions: true } } as const;

export default defineConfig({
  test: {
    /** Only `*.integration.test.ts` gets the blob store. `client.test.ts` stays a unit test even
     * though it opens sockets — it stands up its own `node:http` server.
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
