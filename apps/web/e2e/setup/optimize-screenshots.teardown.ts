import { test as teardown } from '@playwright/test';
import { optimizeScreenshots, wroteScreenshots } from '../../scripts/optimize-screenshots.ts';

// Fires after any local run of `screenshots`, not just `screenshots:update` — so a raw
// `playwright test --project=screenshots --update-snapshots` still ends up optimized.
teardown('committed screenshots are oxipng-optimized', async () => {
  // A plain local run against already-committed images writes nothing — skip re-optimizing.
  if (!(await wroteScreenshots())) return;
  await optimizeScreenshots();
});
