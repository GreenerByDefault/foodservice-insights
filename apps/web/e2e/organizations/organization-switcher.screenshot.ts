/** The switcher and `/orgs` both show *every* organization the signed-in user belongs to, with
 * no `/orgs/<id>` of their own to scope a fixture to — unlike every other screenshot in this
 * suite, which renders inside one dedicated organization (see `reports-list.screenshot.ts`). And
 * every spec shares one identity (`identifyUser` always returns the placeholder user), so what
 * shows up here is whatever else is committed for that user at the moment this test happens to
 * run.
 *
 * The fix is the same one `_loadSwitcherOrganizations` already relies on for its own unit tests:
 * give these organizations a name that sorts ahead of anything an ordinary fixture would use.
 * Every other organization in this suite has a letter-led name (a human-readable one, or
 * `Test org <uuid>`, or the seeded placeholder), so a `"0 "` prefix guarantees these are always
 * first — regardless of what any other, concurrently running spec commits for the same user in
 * the meantime.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

// Both tests below use a "0 "-prefixed name to dominate the sort order (see the file doc comment
// above), which only keeps *other* specs out — nothing stops these two tests' own "0 "-prefixed
// organizations from interleaving with each other if they ran at once. Serial keeps this file's
// fixtures fully torn down before the next test's are created.
test.describe.configure({ mode: 'serial' });

test('the header switcher list, past the cap', async ({ page, organizationMemberships }) => {
  // Already alphabetical, so navigating to the first one keeps it inside the server's own
  // first-eight slice — this branch's header list has no current-first reordering of its own
  // (that lands with the dropdown-menu switcher in `org-switcher`), so a name past the cap simply
  // wouldn't appear in it.
  const names = [
    '0 Switcher Acme Foodservice', // navigated to below
    '0 Switcher Bakers Row',
    '0 Switcher Cedar Grove Dining',
    '0 Switcher Dockside Catering',
    '0 Switcher Elmwood Kitchens',
    '0 Switcher Fairview Foodservice',
    '0 Switcher Grovemont Catering',
    '0 Switcher Harborview Foods',
    '0 Switcher Ivywood Catering', // the ninth: what pushes this past _SWITCHER_LIMIT
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
    '0 List Acme Foodservice',
    '0 List Bakers Row',
    '0 List Cedar Grove Dining',
    '0 List Dockside Catering',
    '0 List Elmwood Kitchens',
    '0 List Fairview Foodservice',
    '0 List Grovemont Catering',
    '0 List Harborview Foods',
    '0 List Ivywood Catering',
  ];
  await Promise.all(names.map((name) => organizationMemberships.create({ name })));

  await page.goto('/orgs');
  await ensureHydrated(page);

  const lastRow = page.getByRole('link', { name: names.at(-1) });
  await expect(lastRow).toBeVisible();

  await expectScreenshots(page, 'orgs-list.png', { clipBelow: lastRow });
});
