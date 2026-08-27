import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';
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

for (const route of ROUTES) {
  test(`${route} has no horizontal overflow at any viewport`, async ({ page }) => {
    await page.goto(route);

    // One navigation, then resize-and-reread per width — resizing is nearly free, a fresh
    // navigation isn't.
    for (const width of Object.values(VIEWPORT_WIDTHS)) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await expectNoHorizontalOverflow(page);
    }
  });
}

test('expectNoHorizontalOverflow fails, and names the offending element, on a page that overflows', async ({
  page,
}) => {
  await page.setContent('<div id="offender" style="width: 2000px; height: 10px;"></div>');
  await page.setViewportSize({ width: 800, height: 600 });

  await expect(expectNoHorizontalOverflow(page)).rejects.toThrow('#offender');
});
