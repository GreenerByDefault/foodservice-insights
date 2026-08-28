/** The one thing no other layer can check: a real click, through the real dialog, hitting the
 * real `POST .../cancel` route, converging on the canceled screen without a page reload.
 *
 * Everything else about cancelling — the dialog's confirm/decline wiring, the feature client's
 * status handling, the canceled screen's copy — is unit- and component-tested already.
 */

import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { ensureHydrated } from '../lib/hydration.ts';

test('canceling a report from the waiting screen shows the canceled screen, without a reload', async ({
  page,
  reports,
}) => {
  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  // A real navigation fires the browser's `load` event again; `invalidate()` re-running the load
  // client-side does not. Counted from here, after the initial navigation's own `load`.
  let loadCount = 0;
  page.on('load', () => {
    loadCount++;
  });

  await page.getByRole('button', { name: 'Cancel report' }).click();
  await page.getByRole('button', { name: 'Yes, cancel report' }).click();

  await expect(page.getByText('You stopped this report')).toBeVisible();
  expect(loadCount).toBe(0);
});
