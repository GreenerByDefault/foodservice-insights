/// <reference types="node" />
import { defineConfig } from '@playwright/test';
import { BROWSER_WS_ENDPOINT } from './e2e/lib/browser-container';

const PORT = 4173;
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
  // the container cannot land beside the real one instead of failing against it.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
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
      testMatch: 'browser-container.setup.ts',
      teardown: 'browser-container-stop',
    },
    {
      name: 'browser-container-stop',
      testMatch: 'browser-container.teardown.ts',
    },
    {
      name: 'screenshots',
      testMatch: '**/*.screenshot.ts',
      dependencies: ['browser-container'],
      use: {
        baseURL: BASE_URL_FROM_CONTAINER,
        connectOptions: { wsEndpoint: BROWSER_WS_ENDPOINT },
        // One width, at 1:1. Each additional viewport multiplies the bytes committed forever;
        // `layout.e2e.ts` covers the cheap part of responsive breakage across three widths.
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
  ],

  webServer: {
    // Runs the real adapter-node output, not `vite preview`, so e2e exercises the
    // deployed artifact. `turbo run test:e2e` depends on `build` running first.
    //
    // These tests commit, so we first clear both the database and the blob store, then bring
    // them up to date with the code. We use `pnpm -r`, rather than the `turbo run` the root scripts
    // use, because Turbo is already running this task.
    //
    // Seeding is only temporary until we add full auth. We should remove it afterwards.
    command:
      'pnpm -r run truncate && pnpm -r run migrate && pnpm -r run seed && ' +
      'node --env-file-if-exists=../../.env.test start.js',
    env: {
      PORT: String(PORT),
      // adapter-node rejects cross-site POSTs with 403 unless ORIGIN is set. Screenshots reach the
      // app on the other hostname, so submitting a form from one would be rejected — keep them to
      // navigation, or make this per-project.
      ORIGIN: BASE_URL,
      TEST_DB: '1',
    },
    // `url` waits for a 2xx response; `port` only waits for a listening socket.
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
