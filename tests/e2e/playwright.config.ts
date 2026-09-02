/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Set by `scripts/test-run.ts`, which `pnpm test:system` routes through. A bare `playwright test`
// would run with no per-run database, no bucket, and — the part unique to this suite — no worker,
// so every spec would sit at `pending` until it timed out.
if (!process.env.TEST_RUN_ID) {
  throw new Error(
    'TEST_RUN_ID is not set. Run this suite through `pnpm test:system` — never `playwright test` ' +
      'directly.',
  );
}

const PORT = Number(process.env.PLAYWRIGHT_PORT);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  // Above the specs' own assertion budgets, which the default 30s would silently cap: a spec here
  // waits on a real queue poll, a real Python child, and a real notification sweep, not on a row
  // it wrote itself.
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  // Eagerly detect flaky tests.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'e2e', testMatch: '**/*.e2e.ts' }],

  webServer: {
    // The same adapter-node output `apps/web`'s own suite runs, from this package instead — hence
    // the `cwd`, which `--env-file-if-exists`'s relative path is resolved against too. `turbo run
    // test:system` builds it first, through this package's `@gbd/web` dependency.
    //
    // No need to migrate or seed: `test-run.ts` hands this process a database cloned from a
    // pre-migrated template, via the `DB_CONNECTION_STRING` it sets, which overrides `.env.test`.
    command: 'node --env-file-if-exists=../../.env.test start.js',
    cwd: fileURLToPath(new URL('../../apps/web', import.meta.url)),
    env: {
      PORT: String(PORT),
      // Both specs POST the upload form, and SvelteKit's CSRF check rejects a POST whose Origin
      // header doesn't match this.
      ORIGIN: BASE_URL,
      TEST_DB: '1',
    },
    // `url` waits for a 2xx response; `port` only waits for a listening socket.
    url: `${BASE_URL}/health`,
    // Every run gets its own port. Reusing a listener here would risk using the server
    // from another worktree.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
