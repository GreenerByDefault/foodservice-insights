/// <reference types="node" />
import {
  assertTestRunId,
  createPlaywrightConfig,
  resolvePlaywrightTarget,
} from '@gbd/browser-testing/playwright-config';
import { defineConfig } from '@playwright/test';
import { SCREENSHOT_VIEWPORTS } from './e2e/lib/viewports';
import { BROWSER_WS_ENDPOINT } from './e2e/setup/browser-container';

assertTestRunId(
  '`pnpm test:e2e`, `pnpm test:screenshots`, `pnpm test:playwright`, or `pnpm screenshots:update`',
);
const { port, baseURL } = resolvePlaywrightTarget();

/** The same app server, addressed from inside the browser container. The alias is set up by
 * `--add-host=host.docker.internal:host-gateway`, which resolves on both macOS and Linux — so
 * this is one URL everywhere rather than a per-platform branch.
 */
const baseURLFromContainer = `http://host.docker.internal:${port}`;

export default defineConfig({
  ...createPlaywrightConfig({
    port,
    baseURL,
    testDir: './e2e',
    // The project boundary decides which browser a test gets, so these patterns must not overlap:
    // a `*.screenshot.ts` picked up by `e2e` would be captured on the host browser.
    projects: [
      {
        // Behaviour, on the host Chromium `playwright install` provides. Gains nothing from
        // pinned rasterization, and would only pay a container hop and lose native `--headed`
        // debugging.
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
          baseURL: baseURLFromContainer,
          connectOptions: { wsEndpoint: BROWSER_WS_ENDPOINT },
          // The width a spec starts at; `expectScreenshots` resizes from here to capture the rest
          // of `SCREENSHOT_VIEWPORTS` on the same navigation.
          viewport: SCREENSHOT_VIEWPORTS.desktop,
          // 1:1. A real phone is 2–3x, but scale factor changes rasterization, not layout — it
          // would multiply the bytes and the pixel-diff cost of every shot while saying nothing new
          // about how the page is laid out.
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
      env: {
        // SvelteKit's CSRF check rejects a POST whose Origin header doesn't match this. It's set
        // to `baseURL`, which is correct for `e2e` (host Chromium, hits it directly) but NOT for
        // `screenshots` (container browser, hits `baseURLFromContainer`) — a form submitted there
        // gets a 403. GETs are unaffected; keep the screenshots project to navigation and seeded
        // DB state, or give the two projects separate webServer origins if that stops being
        // enough.
        ORIGIN: baseURL,
      },
    },
  }),

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
});
