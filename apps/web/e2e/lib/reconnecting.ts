import { advanceThroughPollFailures, ensureHydrated } from '@gbd/browser-testing';
import type { TestOrganization } from '@gbd/browser-testing/fixtures';
import type { Page } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import type { ReportFactory } from '../fixtures/test.ts';
import { watchPageLoads } from './no-reload.ts';
import { POLL_INTERVAL_MS } from './poll-interval.ts';

/** Arrange a pending report whose poll can't reach the server: the clock installed before
 * navigation, the report loaded and hydrated, then two consecutive poll failures advanced
 * through — the base interval, then double it (see `nextPollDelayMs`).
 *
 * Returns a page-load counter started right after the initial navigation's own load — so a
 * caller asserting "never a reload" doesn't have to install its own and account for that one.
 */
export async function makeReportUnreachable(
  page: Page,
  reports: ReportFactory,
  org: TestOrganization,
): Promise<{ readonly count: number }> {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId, org.slug));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);
  await page.route('**/poll', (route) => route.abort());
  await advanceThroughPollFailures(page, '/poll', [POLL_INTERVAL_MS, POLL_INTERVAL_MS * 2]);

  return loads;
}
