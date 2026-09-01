import { ensureHydrated } from '@gbd/browser-testing';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, type Page } from '@playwright/test';
import type { ReportState } from './fixtures/reports.ts';
import { reportUrl } from './fixtures/reports.ts';
import { test } from './fixtures/test.ts';
import { expectNoHorizontalOverflow } from './lib/layout';
import { VIEWPORT_WIDTHS } from './lib/viewports';

// Tall enough that no seeded route's content clips vertically at any checked width; layout
// checks care only about horizontal overflow.
const VIEWPORT_HEIGHT = 1000;

const ROUTES = [
  '/',
  '/sign-in',
  '/orgs',
  `/orgs/${PLACEHOLDER_ORGANIZATION_ID}`,
  `/orgs/${PLACEHOLDER_ORGANIZATION_ID}/settings`,
  `/orgs/${PLACEHOLDER_ORGANIZATION_ID}/members`,
  `/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`,
  '/account',
  '/invites',
  '/no-such-page',
];

/** Resize-and-reread per width, on whatever `page` is currently showing. One navigation, then
 * this — resizing is nearly free, a fresh navigation isn't. */
async function checkNoOverflowAtEveryWidth(page: Page): Promise<void> {
  for (const width of Object.values(VIEWPORT_WIDTHS)) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await expectNoHorizontalOverflow(page);
  }
}

for (const route of ROUTES) {
  test(`${route} has no horizontal overflow at any viewport`, async ({ page }) => {
    await page.goto(route);
    await checkNoOverflowAtEveryWidth(page);
  });
}

// Each of these terminal states has its own action row (download links, retry/contact/delete,
// or just delete) — the one place per screen most likely to wrap awkwardly and overflow.
// 'failed-retried' stands in for the failure screen instead of 'failed': the latter's fixture
// pins a fixed creator email for reports.screenshot.ts's committed screenshot, which collides
// with a concurrent second use of 'failed' anywhere else. See retry.e2e.ts's identical trade-off.
const TERMINAL_STATES: ReportState[] = ['succeeded', 'failed-retried', 'canceled'];

for (const state of TERMINAL_STATES) {
  test(`the ${state} report screen has no horizontal overflow at any viewport`, async ({
    page,
    reports,
  }) => {
    const reportId = await reports.create(state);
    await page.goto(reportUrl(reportId));
    await checkNoOverflowAtEveryWidth(page);
  });
}

// Several distinct kinds of bad row, plus dates written both ways, so the rejection view renders
// its densest layout: the date-order block, multiple row problems, and their examples all at once.
const DENSE_BAD_ROWS_CSV = [
  'product,date,weight',
  'beef,13/02/2026,5 oz',
  'pork,02/13/2026,12 lb',
  ',2026-01-01,3 kg',
  'n/a,2026-01-02,-4',
  'chicken,2026-01-03,$5',
].join('\n');

test('the reports/new rejection view has no horizontal overflow at any viewport', async ({
  page,
}) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(DENSE_BAD_ROWS_CSV),
  });
  await expect(page.getByRole('heading', { name: /problems/ })).toBeVisible();

  await checkNoOverflowAtEveryWidth(page);
});

test('expectNoHorizontalOverflow fails, and names the offending element, on a page that overflows', async ({
  page,
}) => {
  await page.setContent('<div id="offender" style="width: 2000px; height: 10px;"></div>');
  await page.setViewportSize({ width: 800, height: 600 });

  await expect(expectNoHorizontalOverflow(page)).rejects.toThrow('#offender');
});
