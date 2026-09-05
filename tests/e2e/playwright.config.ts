/// <reference types="node" />
import {
  assertTestRunId,
  createPlaywrightConfig,
  resolvePlaywrightTarget,
} from '@gbd/browser-testing/playwright-config';
import { requireEnv } from '@gbd/core/env';
import { defineConfig } from '@playwright/test';
import {
  assertBuiltContainerImages,
  containerStackFromEnv,
  webContainerCommand,
} from './scripts/containers.ts';

assertTestRunId('`pnpm test:system`');
const containerImages = assertBuiltContainerImages();
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
      command: webContainerCommand({
        image: containerImages.web,
        runName,
        port,
        baseURL,
        stack: containerStackFromEnv(),
      }),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
  }),
);
