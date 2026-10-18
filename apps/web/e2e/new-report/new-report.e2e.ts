import { readFileSync } from 'node:fs';
import { ensureHydrated } from '@gbd/browser-testing';
import { APP_NAME } from '@gbd/core';
import type { ReportId } from '@gbd/db';
import { expect } from '@playwright/test';
import { unzipSync } from 'fflate';
import { aWorkbook } from '../../src/lib/reports/excel/testing/workbook.ts';
import { succeedLatestAttempt } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { chooseCsv, chooseWorkbook } from '../lib/upload.ts';

const GOOD_CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

const BAD_ROWS_CSV = ['product,date,weight', 'beef,2026-01-05,5 oz'].join('\n');

test('uploading a good CSV creates a report and lands on its page, which reads back what was entered', async ({
  page,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);
  // The heading's; the empty reports list offers a second.
  await page.getByRole('link', { name: 'New report' }).first().click();

  await page.getByLabel('Report name').fill('Q1 procurement');
  await chooseCsv(page, 'procurement.csv', GOOD_CSV);
  await expect(page.getByText('1 of 1 months still need a count')).toBeVisible();
  await page.getByRole('radio', { name: 'Meals' }).click();
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('1250');
  await page.getByRole('radio', { name: 'kg' }).click();

  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(new RegExp(`/orgs/${org.slug}/reports/[0-9a-f-]+$`));
  await expect(page).toHaveTitle(`Q1 procurement · ${org.name} · ${APP_NAME}`);
  const details = page.getByRole('region', { name: 'Upload details' });
  await expect(details.getByRole('link', { name: 'procurement.csv' })).toBeVisible();
  await expect(details.getByText('kg (kilograms)')).toBeVisible();
  await expect(details.getByText('Meals per month')).toBeVisible();
  await expect(details.getByText('January 2026')).toBeVisible();
  await expect(details.getByText('1,250')).toBeVisible();
});

test('the file field works from the keyboard alone', async ({ page, org }) => {
  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);

  await page.getByRole('heading', { level: 1 }).focus();
  await page.keyboard.press('Tab');

  const input = page.getByLabel('Choose a CSV or Excel file');
  await expect(input).toBeFocused();
  // The input is visually hidden, so the ring on its label is the only sign of where focus is.
  await expect(page.locator('label', { hasText: 'Choose a CSV or Excel file' })).not.toHaveCSS(
    'box-shadow',
    'none',
  );

  const fileChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await fileChooser).setFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(GOOD_CSV),
  });

  await expect(page.getByRole('button', { name: 'Replace' })).toBeFocused();
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

// fflate inflates an entry of 512 KiB or more in a `blob:` worker, which `worker-src` must allow.
test('a workbook big enough to be unzipped in a worker converts', async ({ page, org }) => {
  const workbook = aWorkbook([
    ['product', 'date', 'weight'],
    ...Array.from({ length: 6_000 }, () => ['beef', { date: '2026-01-05' }, 12] as const),
  ]);
  expect(sheetXmlBytes(workbook)).toBeGreaterThan(512 * 1024);

  await page.goto(`/orgs/${org.slug}/reports/new`);
  await ensureHydrated(page);
  await chooseWorkbook(page, 'orders.xlsx', workbook);

  await expect(page.getByText('1 of 1 months still need a count')).toBeVisible();
});

function sheetXmlBytes(workbook: Uint8Array): number {
  let bytes = 0;
  unzipSync(workbook, {
    filter: ({ name, originalSize }) => {
      if (name === 'xl/worksheets/sheet1.xml') bytes = originalSize;
      return false;
    },
  });
  return bytes;
}
