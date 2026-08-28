/** The one thing no other layer can check: a real click hitting the real `POST .../retry`
 * route, converging on the waiting screen without a page reload — and, for the attempt cap, that
 * the assembled page (not just `_loadReport` in isolation) actually withholds the button.
 *
 * Everything else about retrying — the feature client's status handling, the failure copy, the
 * cap arithmetic — is unit- and component-tested already.
 */

import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { ensureHydrated } from '../lib/hydration.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('retrying a failed report shows the waiting screen, without a reload', async ({
  page,
  reports,
}) => {
  const reportId = await reports.create('failed');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByText('Waiting to start')).toBeVisible();
  expect(loads.count).toBe(0);
});

test('a report at the attempt cap has no retry button', async ({ page, reports }) => {
  const reportId = await reports.create('failed-at-retry-cap');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText("You've used all", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible();
});
