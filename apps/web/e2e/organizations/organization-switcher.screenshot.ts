/** The switcher and `/orgs` both show *every* organization the signed-in user belongs to, with
 * no `/orgs/<id>` of their own to scope a fixture to — unlike every other screenshot in this
 * suite, which renders inside one dedicated organization (see `reports-list.screenshot.ts`). And
 * every spec shares one identity (`identifyUser` always returns the placeholder user), so what
 * shows up here is whatever else is committed for that user at the moment this test happens to
 * run — including the seeded placeholder organization itself, `"Phase One Foodservice"`.
 *
 * The fix is the same one `_loadSwitcherOrganizations` already relies on for its own unit tests:
 * give these organizations a name that sorts ahead of anything an ordinary fixture would use.
 * Every other organization in this suite has a letter-led name (a human-readable one, `Test org
 * <uuid>`, or the seeded placeholder), so no letter can promise "always first" — some other name,
 * present or future, is free to start earlier in the alphabet. A leading digit can promise that,
 * since it sorts before every letter, so these are named like a real digit-led foodservice
 * chain — `"24/7 …"` — rather than with a bare, test-only-looking prefix.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

// Both tests below use a "24/7 "-prefixed name to dominate the sort order (see the file doc
// comment above), which only keeps *other* specs out — nothing stops these two tests' own
// "24/7 "-prefixed organizations from interleaving with each other if they ran at once. Serial
// keeps this file's fixtures fully torn down before the next test's are created.
test.describe.configure({ mode: 'serial' });

test('the header switcher list, past the cap', async ({ page, organizationMemberships }) => {
  // Already alphabetical, so navigating to the first one keeps it inside the server's own
  // first-eight slice — this branch's header list has no current-first reordering of its own
  // (that lands with the dropdown-menu switcher in `org-switcher`), so a name past the cap simply
  // wouldn't appear in it.
  const names = [
    '24/7 Switcher Acme Foodservice', // navigated to below
    '24/7 Switcher Bakers Row',
    '24/7 Switcher Cedar Grove Dining',
    '24/7 Switcher Dockside Catering',
    '24/7 Switcher Elmwood Kitchens',
    '24/7 Switcher Fairview Foodservice',
    '24/7 Switcher Grovemont Catering',
    '24/7 Switcher Harborview Foods',
    '24/7 Switcher Ivywood Catering', // the ninth: what pushes this past _SWITCHER_LIMIT
  ];
  const [currentId] = await Promise.all(
    names.map((name) => organizationMemberships.create({ name })),
  );

  await page.goto(`/orgs/${currentId}`);
  await ensureHydrated(page);

  await page.locator('summary').click();
  // Scoped to the switcher's own list, not the page as a whole — the organization page renders
  // its own nav links ("Reports", "Members", "Settings") that `getByRole('link')` would otherwise
  // pick up too. The server-side cap is what this test guards: the list never grows past it, no
  // matter how many organizations the user belongs to.
  const organizationRows = page.locator('details ul a').filter({ hasNotText: 'New organization' });
  await expect(organizationRows).toHaveCount(8);

  await expectScreenshots(page, 'organization-switcher.png');
});

test('the /orgs list, past eight organizations', async ({ page, organizationMemberships }) => {
  // Already alphabetical, so the last name here is also the last row on the page — the one
  // `expectScreenshots` crops the capture against (see its `clipBelow` doc comment).
  const names = [
    '24/7 List Acme Foodservice',
    '24/7 List Bakers Row',
    '24/7 List Cedar Grove Dining',
    '24/7 List Dockside Catering',
    '24/7 List Elmwood Kitchens',
    '24/7 List Fairview Foodservice',
    '24/7 List Grovemont Catering',
    '24/7 List Harborview Foods',
    '24/7 List Ivywood Catering',
  ];
  await Promise.all(names.map((name) => organizationMemberships.create({ name })));

  await page.goto('/orgs');
  await ensureHydrated(page);

  const lastRow = page.getByRole('link', { name: names.at(-1) });
  await expect(lastRow).toBeVisible();

  await expectScreenshots(page, 'orgs-list.png', { clipBelow: lastRow });
});
