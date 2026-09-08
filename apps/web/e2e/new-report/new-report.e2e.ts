import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { chooseCsv } from '../lib/upload.ts';

const GOOD_CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

const BAD_ROWS_CSV = ['product,date,weight', 'beef,2026-01-05,5 oz'].join('\n');

test('uploading a good CSV creates a report and lands on its page', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);
  await page.getByRole('link', { name: 'New report' }).click();

  await page.getByLabel('Report name').fill('Q1 procurement');
  await chooseCsv(page, 'procurement.csv', GOOD_CSV);
  await expect(page.getByText('1 of 1 months still need a count')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('radio', { name: 'lb' }).click();

  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(new RegExp(`/orgs/${org.slug}/reports/[0-9a-f-]+$`));
  await expect(page).toHaveTitle('Q1 procurement');
});

test('uploading a CSV with bad rows shows the rejection view, naming them, without ever submitting', async ({
  page,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'procurement.csv', BAD_ROWS_CSV);

  await expect(page.getByRole('heading', { name: /problems/ })).toBeVisible();
  await expect(page.getByText('The weight has a unit in it.')).toBeVisible();
  await expect(page.getByText('No report was created.')).toBeVisible();
});
