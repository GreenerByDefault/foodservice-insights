/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import {
  assertTestRunId,
  createPlaywrightConfig,
  resolvePlaywrightTarget,
} from '@gbd/browser-testing/playwright-config';
import { defineConfig } from '@playwright/test';

assertTestRunId('`pnpm test:system`');
const { port, baseURL } = resolvePlaywrightTarget();

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
      // The same adapter-node output `apps/web`'s own suite runs, from this package instead —
      // hence the `cwd`, which `--env-file-if-exists`'s relative path is resolved against too.
      // `turbo run test:system` builds it first, through this package's `@gbd/web` dependency.
      cwd: fileURLToPath(new URL('../../apps/web', import.meta.url)),
    },
  }),
);
