/** A tab left polling across a web deploy reloads rather than reading the new build's response
 * with the old build's JavaScript. `live-update.e2e.ts` covers the other half: a response from this
 * build, header and all, never reloads.
 */

import { advancePoll, ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('a poll answered by another deploy reloads the page', async ({ page, reports, org }) => {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId, org.slug));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);
  await page.route('**/poll', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'x-deploy-version': 'another-build' },
    });
  });

  await advancePoll(page, POLL_INTERVAL_MS);
  await expect.poll(() => loads.count).toBe(1);
});
