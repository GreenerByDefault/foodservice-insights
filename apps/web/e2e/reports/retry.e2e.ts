/** The one thing no other layer can check: a real click hitting the real `POST .../retry`
 * route, converging on the waiting screen without a page reload, and the poll the settled failure
 * screen had stopped picking back up.
 *
 * Everything else about retrying — the feature client's status handling, the failure copy, the
 * cap arithmetic — is unit- and component-tested already; the cap's own screen is covered by
 * `reports.screenshot.ts`'s `failed-at-retry-cap` case.
 */

import { advancePoll, ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { reportUrl, succeedLatestAttempt } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('retrying a failed report shows the waiting screen and resumes polling, without a reload', async ({
  page,
  reports,
  db,
}) => {
  // Installed before navigation so it is in place before the retry re-arms the page's timer.
  await page.clock.install();

  // Not 'failed': that fixture pins a fixed creator email for reports.screenshot.ts's committed
  // screenshot, which collides with a concurrent run of this test. 'failed-retried' still has
  // attempts to spare, so retry behaves the same either way.
  const reportId = await reports.create('failed-retried');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByText('You can close this page', { exact: false })).toBeVisible();

  // A failed report is settled, so the page had stopped polling. Retrying is the one thing that
  // un-settles it without a poll, and nothing catches that up unless the schedule restarts —
  // so finish the new attempt from underneath the page and require it to notice.
  await succeedLatestAttempt(db, reportId);

  await advancePoll(page, POLL_INTERVAL_MS);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  expect(loads.count).toBe(0);
});
