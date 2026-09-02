/** The one thing no other layer can check: block the poll, and the timeline has to stay up and
 * say so — never a reload, never an error page.
 *
 * This is what the endpoint's existence stands on: SvelteKit's `invalidate()` falls back to a
 * full-page navigation when its own data request fails at the network level, which breaks the
 * page outright once the connection itself is the problem (see `README.md` § Routes). Polling a
 * dedicated `+server.ts` with a plain `fetch` avoids that.
 */

import { advanceThroughPollFailures, ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('an unreachable poll leaves the timeline up and shows a reconnecting notice, never a reload', async ({
  page,
  reports,
}) => {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);
  await page.route('**/poll', (route) => route.abort());

  // Two consecutive failures: the base interval, then double it — see `nextPollDelayMs`.
  await advanceThroughPollFailures(page, '/poll', [POLL_INTERVAL_MS, POLL_INTERVAL_MS * 2]);

  await expect(page.getByText('We lost the connection', { exact: false })).toBeVisible();
  await expect(page.getByText('You can close this page', { exact: false })).toBeVisible();
  expect(loads.count).toBe(0);
});
