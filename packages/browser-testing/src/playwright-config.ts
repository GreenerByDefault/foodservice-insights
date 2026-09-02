import type { PlaywrightTestConfig } from '@playwright/test';

/** Throws unless `test-run.ts` has already set up this run — before `PLAYWRIGHT_PORT` or any
 * other run-scoped env var is read. A bare `playwright test` would otherwise silently fall back
 * to a fixed port and the shared database, reintroducing the concurrent-run issues `test-run.ts`
 * fixes.
 *
 * `requiredRunCommand` is named in the error, since which pnpm script is correct differs by
 * suite.
 */
export function assertTestRunId(requiredRunCommand: string): void {
  if (!process.env.TEST_RUN_ID) {
    throw new Error(
      `TEST_RUN_ID is not set. Run tests through ${requiredRunCommand} — never \`playwright test\` ` +
        'directly.',
    );
  }
}

/** The port and base URL `test-run.ts` assigned this run. Call only after `assertTestRunId`. */
export function resolvePlaywrightTarget(): { port: number; baseURL: string } {
  const port = Number(process.env.PLAYWRIGHT_PORT);
  return { port, baseURL: `http://localhost:${port}` };
}

export type CreatePlaywrightConfigOptions = {
  port: number;
  baseURL: string;
  testDir: string;
  projects: PlaywrightTestConfig['projects'];
  /** Overrides Playwright's default 30s top-level timeout, for a suite whose specs wait on more
   * than an assertion they wrote themselves. */
  timeout?: number;
  webServer?: {
    /** Set when the config isn't itself next to the app's `start.js` — e.g. `tests/e2e`, which
     * runs `apps/web`'s build from outside that package. */
    cwd?: string;
    /** Merged on top of the shared `PORT`/`ORIGIN`/`TEST_DB`. */
    env?: Record<string, string>;
  };
};

/**
 * Shared skeleton every Playwright config in the repo builds on: the `fullyParallel`/
 * `reporter`/`use`/`webServer` fields that don't vary between suites. A caller resolves
 * `assertTestRunId` and `resolvePlaywrightTarget` itself first — it usually needs `port`/
 * `baseURL` to build its own projects or webServer env before this can run — then spreads the
 * returned config into its own `defineConfig()` call and layers on what does vary
 * (`snapshotPathTemplate`, `expect.toHaveScreenshot`, extra projects).
 */
export function createPlaywrightConfig(
  options: CreatePlaywrightConfigOptions,
): PlaywrightTestConfig {
  const { port, baseURL, testDir, projects, timeout, webServer } = options;

  return {
    testDir,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // Eagerly detect flaky tests.
    retries: 0,
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
    use: {
      baseURL,
      trace: 'retain-on-failure',
    },
    projects,
    ...(timeout !== undefined ? { timeout } : {}),
    webServer: {
      // Runs the real adapter-node output, not `vite preview`, so a suite built on this exercises
      // the deployed artifact. `turbo run test:e2e`/`test:system` depend on `build` running
      // first.
      //
      // No need to migrate or seed the database: `test-run.ts` already hands this process a
      // database cloned from a pre-migrated template. It sets `DB_CONNECTION_STRING`, which
      // overrides `.env.test`.
      command: 'node --env-file-if-exists=../../.env.test start.js',
      ...(webServer?.cwd !== undefined ? { cwd: webServer.cwd } : {}),
      env: {
        PORT: String(port),
        // SvelteKit's CSRF check rejects a POST whose Origin header doesn't match this. A caller
        // whose browser hits the server through a different address (e.g. from inside a
        // container) overrides it via `webServer.env`.
        ORIGIN: baseURL,
        TEST_DB: '1',
        ...webServer?.env,
      },
      // `url` waits for a 2xx response; `port` only waits for a listening socket.
      url: `${baseURL}/health`,
      // Every run gets its own port. Reusing a listener here would risk using the server from
      // another worktree.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  };
}
