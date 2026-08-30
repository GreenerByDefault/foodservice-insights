import { test as teardown } from '@playwright/test';
import { optimizeScreenshots } from '../../scripts/optimize-screenshots.ts';

// Fires after any local run of `screenshots`, not just `screenshots:update` — so a raw
// `playwright test --project=screenshots --update-snapshots` still ends up optimized.
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires this shape to read testInfo without a fixture.
teardown('committed screenshots are oxipng-optimized', async ({}, testInfo) => {
  // 'none' in CI (see playwright.config.ts) — nothing was written, so nothing to optimize.
  if (testInfo.config.updateSnapshots === 'none') return;
  await optimizeScreenshots();
});
