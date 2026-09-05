/// <reference types="node" />
import {
  assertTestRunId,
  createPlaywrightConfig,
  resolvePlaywrightTarget,
} from '@gbd/browser-testing/playwright-config';
import { requireEnv } from '@gbd/core/env';
import { defineConfig } from '@playwright/test';
import {
  assertBuiltImages,
  containerStackFromEnv,
  webContainerCommand,
} from './scripts/containers.ts';

assertTestRunId('`pnpm test:system`');
const images = assertBuiltImages();
const { port, baseURL } = resolvePlaywrightTarget();
const runName = requireEnv('TEST_RUN_ID');

export default defineConfig(
  createPlaywrightConfig({
    port,
    baseURL,
    testDir: './specs',
    // Above the specs' own assertion budgets, which the default 30s would silently cap: a spec
    // here waits on a real queue poll, a real Python child, and a real notification sweep, not on
    // a row it wrote itself.
    timeout: 120_000,
    projects: [{ name: 'e2e', testMatch: '**/*.e2e.ts' }],
    webServer: {
      // The deployed artifact itself, not a host process running its build output — this tier is
      // the only thing that validates either image. `scripts/test-run.ts` built them and named
      // them in the environment; `assertBuiltImages` is what refuses to run without that.
      command: webContainerCommand({
        image: images.web,
        runName,
        port,
        baseURL,
        stack: containerStackFromEnv(),
      }),
      // A killed `docker run` leaves its container running, and Playwright's default teardown is
      // SIGKILL to the process group. The container is removed in `test-run.ts` either way; this
      // is what lets the app shut down cleanly first.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
  }),
);
