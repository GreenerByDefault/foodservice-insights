import { ensureHydrated } from '@gbd/browser-testing';
import type { ReportId } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { chooseCsv } from '../lib/upload.ts';

const GOOD_CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

const BAD_ROWS_CSV = ['product,date,weight', 'beef,2026-01-05,5 oz'].join('\n');

/** Extracts the id this test's own upload created, from the URL it lands on. */
function reportIdFromUrl(url: string): ReportId {
  const match = /\/reports\/([0-9a-f-]+)$/.exec(url);
  if (!match) throw new Error(`expected a report URL, got ${url}`);
  return match[1] as ReportId;
}

test('uploading a good CSV creates a report and lands on its page', async ({ page, db }) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`);
  await ensureHydrated(page);
  await page.getByRole('link', { name: 'New report' }).click();

  await page.getByLabel('Report name').fill('Q1 procurement');
  await chooseCsv(page, 'procurement.csv', GOOD_CSV);
  await expect(page.getByText('1 of 1 months still need a count')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('radio', { name: 'lb' }).click();

  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(
    new RegExp(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/[0-9a-f-]+$`),
  );
  await expect(page).toHaveTitle('Q1 procurement');

  // Playwright runs every e2e spec against one shared run database (fullyParallel), so this
  // report must not outlive the test: left behind, it'd skew another test's report-list count
  // or eat into the placeholder org's rate limit.
  await db.deleteFrom('report').where('id', '=', reportIdFromUrl(page.url())).execute();
});

test('uploading a CSV with bad rows shows the rejection view, naming them, without ever submitting', async ({
  page,
}) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  await chooseCsv(page, 'procurement.csv', BAD_ROWS_CSV);

  await expect(page.getByRole('heading', { name: /problems/ })).toBeVisible();
  await expect(page.getByText('The weight has a unit in it.')).toBeVisible();
  await expect(page.getByText('No report was created.')).toBeVisible();
});
