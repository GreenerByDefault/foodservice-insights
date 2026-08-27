import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, type Page } from '@playwright/test';
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

test('the succeeded report screen has no horizontal overflow at any viewport', async ({
  page,
  reports,
}) => {
  // Not in ROUTES: it's the tallest report screen with the most links, so every other report
  // state is strictly less content. `/reports/new` above already covers the route shape.
  const reportId = await reports.create('succeeded');
  await page.goto(reportUrl(reportId));
  await checkNoOverflowAtEveryWidth(page);
});

test('expectNoHorizontalOverflow fails, and names the offending element, on a page that overflows', async ({
  page,
}) => {
  await page.setContent('<div id="offender" style="width: 2000px; height: 10px;"></div>');
  await page.setViewportSize({ width: 800, height: 600 });

  await expect(expectNoHorizontalOverflow(page)).rejects.toThrow('#offender');
});
