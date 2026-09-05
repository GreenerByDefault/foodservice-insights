/** The one thing no other layer can check: a real poll, hitting the real read endpoint, updating
 * the screen with no page reload.
 *
 * Everything about the schedule itself is covered by `polling/schedule.test.ts`, and everything
 * about the screens themselves by their own component tests.
 */

import { advancePoll, ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { reportUrl, succeedLatestAttempt } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('a report that finishes while the page is open updates in place, without a reload', async ({
  page,
  reports,
  db,
}) => {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await succeedLatestAttempt(db, reportId);

  await advancePoll(page, POLL_INTERVAL_MS);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  expect(loads.count).toBe(0);
});
