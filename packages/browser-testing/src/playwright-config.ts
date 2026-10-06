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
    /** Replaces the default `node start.js`. A caller that starts the app some other way — e.g.
     * `tests/e2e`, which runs it as a container — supplies its own here.
     *
     * **`env` below does not reach a command that is only a launcher.** Playwright sets it on the
     * process it spawns, so for a `docker run` it lands on the CLI rather than in the container:
     * such a command has to carry `PORT`, `PROTOCOL_HEADER` and the rest itself. */
    command?: string;
    /** Set when the config isn't itself next to the app's `start.js` — e.g. `tests/e2e`, which
     * runs `apps/web`'s build from outside that package. */
    cwd?: string;
    /** Merged on top of the shared `PORT`/`PROTOCOL_HEADER`/`TEST_DB`. */
    env?: Record<string, string>;
    /** Opt in to a SIGTERM-then-wait teardown. Playwright's default is SIGKILL to the process
     * group, which is fine for a server it owns directly but strands whatever a launcher command
     * started — a killed `docker run` leaves its container running. */
    gracefulShutdown?: { signal: 'SIGTERM'; timeout: number };
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
      // Pairs with `PROTOCOL_HEADER` below, standing in for the TLS proxy that fronts production.
      // Without it adapter-node assumes `https`, so SvelteKit's CSRF check would refuse every POST
      // to this plain-HTTP server. Not `ORIGIN`: SvelteKit 3 replaces it with a build-time
      // `paths.origin`, and this runs the production build.
      extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
    },
    projects,
    ...(timeout !== undefined ? { timeout } : {}),
    webServer: {
      // The default runs the real adapter-node output, not `vite preview`, so a suite built on
      // this exercises the deployed artifact. `turbo run test:e2e` depends on `build` running
      // first.
      //
      // No need to migrate or seed the database: `test-run.ts` already hands this process a
      // database cloned from a pre-migrated template. It sets `DB_CONNECTION_STRING`, which
      // overrides `.env.test`.
      command: webServer?.command ?? 'node --env-file-if-exists=../../.env.test start.js',
      ...(webServer?.cwd !== undefined ? { cwd: webServer.cwd } : {}),
      ...(webServer?.gracefulShutdown !== undefined
        ? { gracefulShutdown: webServer.gracefulShutdown }
        : {}),
      env: {
        PORT: String(port),
        PROTOCOL_HEADER: 'x-forwarded-proto',
        TEST_DB: '1',
        // Off, so only the client ever closes an idle connection. Playwright's API client
        // (`request`, `page.request`) pools keep-alive sockets per worker and ignores the server's
        // `Keep-Alive: timeout` hint, so it will reuse one right as the server's 6s idle timer
        // expires. If the server's event loop is busy with another worker's request at that
        // moment, its timer runs before it reads the new request, and the client gets
        // `write EPIPE`.
        KEEP_ALIVE_TIMEOUT: '0',
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
