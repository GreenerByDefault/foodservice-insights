import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';
import { ensureHydrated } from '../lib/hydration.ts';

const GOOD_CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

const BAD_ROWS_CSV = ['product,date,weight', 'beef,2026-01-05,5 oz'].join('\n');

test('uploading a good CSV creates a report and lands on its page', async ({ page }) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`);
  await ensureHydrated(page);
  await page.getByRole('link', { name: 'New report' }).click();

  await page.getByLabel('Report name').fill('Q1 procurement');
  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(GOOD_CSV),
  });
  await expect(page.getByText('1 of 1 months still need a count')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('radio', { name: 'lb' }).click();

  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(
    new RegExp(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/[0-9a-f-]+$`),
  );
  await expect(page).toHaveTitle('Q1 procurement');

  // Every test mints its own report and deletes it when it ends, per e2e/README.md. A fresh
  // report is "Waiting to start", which only offers cancel — canceling reaches the terminal
  // state that offers delete.
  await page.getByRole('button', { name: 'Cancel report' }).click();
  await page.getByRole('button', { name: 'Yes, cancel report' }).click();
  await page.getByRole('button', { name: 'Delete report' }).click();
  await page.getByRole('button', { name: 'Yes, delete report' }).click();
});

test('uploading a CSV with bad rows shows the rejection view, naming them, without ever submitting', async ({
  page,
}) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(BAD_ROWS_CSV),
  });

  await expect(page.getByRole('heading', { name: /problems/ })).toBeVisible();
  await expect(page.getByText('The weight has a unit in it.')).toBeVisible();
  await expect(page.getByText('No report was created.')).toBeVisible();
});
