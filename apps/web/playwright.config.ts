/// <reference types="node" />
import { defineConfig } from '@playwright/test';
import { BROWSER_WS_ENDPOINT } from './e2e/setup/browser-container';

// Set by `apps/web/scripts/test-run.ts`, which every Playwright pnpm script routes through.
// A bare `playwright test` would otherwise silently fall back to a fixed port and the shared
// database, reintroducing the concurrent-run issues that `test-run.ts` fixes.
if (!process.env.TEST_RUN_ID) {
  throw new Error(
    'TEST_RUN_ID is not set. Run tests through `pnpm test:e2e`, `pnpm test:screenshots`, ' +
      '`pnpm test:playwright`, or `pnpm screenshots:update` — never `playwright test` directly.',
  );
}

const PORT = Number(process.env.PLAYWRIGHT_PORT);
const BASE_URL = `http://localhost:${PORT}`;
/** The same app server, addressed from inside the browser container. The alias is set up by
 * `--add-host=host.docker.internal:host-gateway`, which resolves on both macOS and Linux — so
 * this is one URL everywhere rather than a per-platform branch.
 */
const BASE_URL_FROM_CONTAINER = `http://host.docker.internal:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // vitest owns *.{test,spec}.ts; Playwright owns *.e2e.ts and *.screenshot.ts.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Eagerly detect flaky tests.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  // One canonical file per shot: no `-darwin`/`-chromium` suffixes, so a screenshot taken outside
  // the container cannot land beside the real one instead of failing against it. Nested by
  // `{testFileDir}` (empty for a spec directly under `e2e/`, so `{/testFileDir}` adds no segment
  // there) so the shot names don't have to carry a feature prefix to stay a global namespace.
  snapshotPathTemplate: '{testDir}/__screenshots__{/testFileDir}/{arg}{ext}',
  // Locally, a new shot is written on first run. In CI a missing snapshot is a failure — it means
  // someone added a screenshot test without committing its image.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  expect: {
    toHaveScreenshot: {
      // Exact equality: any tolerance lets a real change pass without rewriting the image, so the
      // committed PNG drifts from what the app renders. Both are needed — `maxDiffPixels: 0`
      // alone still permits every pixel to differ by up to the default `threshold` of 0.2.
      threshold: 0,
      maxDiffPixels: 0,
    },
  },

  // The project boundary decides which browser a test gets, so these patterns must not overlap: a
  // `*.screenshot.ts` picked up by `e2e` would be captured on the host browser.
  projects: [
    {
      // Behaviour, on the host Chromium `playwright install` provides. Gains nothing from pinned
      // rasterization, and would only pay a container hop and lose native `--headed` debugging.
      name: 'e2e',
      testMatch: '**/*.e2e.ts',
    },
    {
      name: 'browser-container',
      testMatch: '**/browser-container.setup.ts',
      teardown: 'browser-container-stop',
    },
    {
      name: 'browser-container-stop',
      testMatch: '**/browser-container.teardown.ts',
    },
    {
      name: 'screenshots',
      testMatch: '**/*.screenshot.ts',
      dependencies: ['browser-container'],
      teardown: 'screenshots-optimize',
      use: {
        baseURL: BASE_URL_FROM_CONTAINER,
        connectOptions: { wsEndpoint: BROWSER_WS_ENDPOINT },
        // One width, at 1:1. Each additional viewport multiplies the bytes committed forever;
        // `layout.e2e.ts` covers the cheap part of responsive breakage across three widths.
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
    {
      // Re-compresses any snapshot the run wrote. See optimize-screenshots.teardown.ts.
      name: 'screenshots-optimize',
      testMatch: '**/optimize-screenshots.teardown.ts',
    },
  ],

  webServer: {
    // Runs the real adapter-node output, not `vite preview`, so e2e exercises the
    // deployed artifact. `turbo run test:e2e` depends on `build` running first.
    //
    // No need to migrate or seed the database: `test-run.ts` already hands this process a database
    // cloned from a pre-migrated template. The script sets `DB_CONNECTION_STRING`, which
    // overrides `env.test`.
    command: 'node --env-file-if-exists=../../.env.test start.js',
    env: {
      PORT: String(PORT),
      // SvelteKit's CSRF check rejects a POST whose Origin header doesn't match this. It's set to
      // BASE_URL, which is correct for `e2e` (host Chromium, hits BASE_URL directly) but NOT for
      // `screenshots` (container browser, hits BASE_URL_FROM_CONTAINER) — a form submitted there
      // gets a 403. GETs are unaffected; keep the screenshots project to navigation and seeded DB
      // state, or give the two projects separate webServer origins if that stops being enough.
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
