/** The one thing no other layer can check: block the poll, and the timeline has to stay up and
 * say so — never a reload, never an error page.
 *
 * This is what the endpoint's existence stands on: SvelteKit's `invalidate()` falls back to a
 * full-page navigation when its own data request fails at the network level, which breaks the
 * page outright once the connection itself is the problem (see `README.md` § Routes). Polling a
 * dedicated `+server.ts` with a plain `fetch` avoids that.
 */

import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { ensureHydrated } from '../lib/hydration.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('an unreachable poll leaves the timeline up and shows a reconnecting notice, never a reload', async ({
  page,
  reports,
}) => {
  // Two consecutive failures at 10s then 20s — see `polling/schedule.ts` — plus margin.
  test.setTimeout(60_000);

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);
  await page.route('**/poll', (route) => route.abort());

  await expect(page.getByText('Having trouble reaching the server', { exact: false })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText('You can close this page', { exact: false })).toBeVisible();
  expect(loads.count).toBe(0);
});
