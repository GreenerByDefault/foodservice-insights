import { readFileSync } from 'node:fs';
import { ensureHydrated } from '@gbd/browser-testing';
import type { ReportId } from '@gbd/db';
import { expect } from '@playwright/test';
import { succeedLatestAttempt } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { chooseCsv, chooseWorkbook } from '../lib/upload.ts';

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

test('uploading a workbook creates a report whose uploaded file is the workbook itself', async ({
  page,
  db,
  org,
}) => {
  const workbook = readFileSync(
    new URL('../../src/lib/reports/excel/testing/fixtures/openpyxl-orders.xlsx', import.meta.url),
  );

  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Report name').fill('Q1 procurement');
  await chooseWorkbook(page, 'orders.xlsx', workbook);
  // The months only appear once the browser has converted the workbook and read the CSV, so
  // seeing both of the fixture's is what proves the conversion ran here rather than on the server.
  await expect(page.getByText('2 of 2 months still need a count')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('spinbutton', { name: 'February 2026' }).fill('120');
  await page.getByRole('radio', { name: 'lb' }).click();

  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(new RegExp(`/orgs/${org.slug}/reports/[0-9a-f-]+$`));
  const reportId = page.url().split('/').pop() as ReportId;
  await succeedLatestAttempt(db, reportId);
  await page.reload();

  const link = page.getByRole('link', { name: 'orders.xlsx' });
  await expect(link).toBeVisible();

  const download = await page.request.get((await link.getAttribute('href')) as string);
  expect(download.headers()['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  expect(new Uint8Array(await download.body())).toEqual(new Uint8Array(workbook));
});
