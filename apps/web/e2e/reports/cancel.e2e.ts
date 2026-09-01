/** The one thing no other layer can check: a real click, through the real dialog, hitting the
 * real `POST .../cancel` route, converging on the canceled screen without a page reload.
 *
 * Everything else about cancelling — the dialog's confirm/decline wiring, the feature client's
 * status handling, the canceled screen's copy — is unit- and component-tested already.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('canceling a report from the waiting screen shows the canceled screen, without a reload', async ({
  page,
  reports,
}) => {
  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await page.getByRole('button', { name: 'Cancel report' }).click();
  await page.getByRole('button', { name: 'Yes, cancel report' }).click();

  await expect(page.getByText('Someone stopped this report')).toBeVisible();
  expect(loads.count).toBe(0);
});
