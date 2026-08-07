/** The upload path against the built server, which is the only place three of its constraints
 * exist: `BODY_SIZE_LIMIT`, SvelteKit's CSRF origin check, and the seeded identity surviving the
 * truncate → migrate → seed chain. Everything else about the handlers is covered far more
 * cheaply by the vitest tests beside them.
 */

import { expect, test } from '@playwright/test';

/** Comfortably past adapter-node's 512K default, and well under the 10MB product cap — so this
 * upload only succeeds if `BODY_SIZE_LIMIT` is actually configured.
 */
const LARGE_CSV = `product name,date ordered,amount ordered\n${'beef mince,2026-01-05,12\n'.repeat(40_000)}`;

test('uploads a CSV through the form and shows the report', async ({ page }) => {
  await page.goto('/reports/new');

  await page.getByLabel('Report name').fill('Q1 procurement');
  await page.getByLabel('Site name (optional)').fill('Main dining hall');
  await page.getByLabel('Counts are').selectOption('people');
  await page.getByLabel('Weights are in').selectOption('kg');
  await page
    .getByLabel('Diners or meals per month, as JSON')
    .fill('{"2026-01": 120, "2026-02": 135}');
  await page.getByLabel(/Procurement CSV/).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(LARGE_CSV),
  });

  await page.getByRole('button', { name: 'Upload' }).click();

  await expect(page).toHaveURL(/\/reports\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Q1 procurement');
  await expect(page.getByText('procurement.csv')).toBeVisible();
  // Queued for a worker that does not exist yet, which is the correct phase-1 end state.
  await expect(page.getByText('pending')).toBeVisible();

  // The stable link hands out a short-lived signed URL rather than serving the bytes itself.
  const href = await page.getByRole('link', { name: 'procurement.csv' }).getAttribute('href');
  const download = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect(download.status()).toBe(302);
});

test('answers a rejected upload with the code the client branches on', async ({
  request,
  baseURL,
}) => {
  const response = await request.post('/api/reports', {
    // Playwright sends no Origin, and SvelteKit forbids a multipart POST without one outside
    // dev. A real browser always sends it, so only this tier has to say so.
    headers: { origin: baseURL ?? '' },
    multipart: {
      'report-name': 'Q1 procurement',
      'counts-basis': 'people',
      'unit-system': 'lb',
      'monthly-counts': '{"2026-01": 120}',
      file: { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') },
    },
  });

  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'empty' });
});
