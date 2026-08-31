import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';
import { ensureHydrated } from './lib/hydration.ts';
import { expectScreenshot } from './lib/screenshots.ts';

test('the new report form, with the monthly counts component partway filled in', async ({
  page,
}) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  // Fills three of the four months and leaves one untouched — a mid-progress state exercises
  // the progress line and the filled/empty input contrast that an all-empty or all-filled shot
  // would miss.
  await page.getByRole('spinbutton', { name: 'November 2025' }).fill('120');
  await page.getByRole('spinbutton', { name: 'December 2025' }).fill('115');
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('130');

  await expect(page.getByText('1 of 4 months still need a count')).toBeVisible();
  await expectScreenshot(page, 'reports-new-monthly-counts.png');
});
