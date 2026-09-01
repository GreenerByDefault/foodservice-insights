import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';
import { ensureHydrated } from '../lib/hydration.ts';
import { expectScreenshot } from '../lib/screenshots.ts';

// Spans two years, like the fixture this replaced, so the shot also exercises the year headings.
const CSV = [
  'product,date,weight',
  'beef,2025-11-05,12',
  'beef,2025-12-05,12',
  'beef,2026-01-05,12',
  'beef,2026-02-05,12',
].join('\n');

test('the new report form, with the monthly counts component partway filled in', async ({
  page,
}) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });

  // Fills three of the four months and leaves one untouched — a mid-progress state exercises
  // the progress line and the filled/empty input contrast that an all-empty or all-filled shot
  // would miss.
  await page.getByRole('spinbutton', { name: 'November 2025' }).fill('120');
  await page.getByRole('spinbutton', { name: 'December 2025' }).fill('115');
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('130');

  await expect(page.getByText('1 of 4 months still need a count')).toBeVisible();
  await expectScreenshot(page, 'reports-new.png');
});
