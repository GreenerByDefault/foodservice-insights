import { DATABASE, shutdown } from '@gbd/db/env';
import { test as setup } from '@playwright/test';
import { clearReportFixtures } from '../fixtures/reports.ts';

// A dependency of both `e2e` and `screenshots` (see playwright.config.ts), so this finishes
// before any spec in either suite starts. That barrier is what lets it delete every fixture
// report in the placeholder organization unconditionally — no age heuristic, no marker column,
// no race with a spec that is still running. It's also what recovers from a run that was
// Ctrl-C'd mid-way: the leftover reports from that run would otherwise count against the
// organization's rate limit the next time `test:screenshots` runs against a reused server.
setup('report fixtures start clean', async () => {
  await clearReportFixtures(DATABASE);
  await shutdown();
});
