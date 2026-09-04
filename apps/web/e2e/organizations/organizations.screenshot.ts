/** The switcher and `/orgs` both show *every* organization the signed-in user belongs to, with
 * no `/orgs/<id>` of their own to scope a fixture to — unlike every other screenshot in this
 * suite, which renders inside one dedicated organization (see `reports-list.screenshot.ts`). And
 * every spec shares one identity (`identifyUser` always returns the placeholder user), so what
 * shows up here is whatever else is committed for that user at the moment this test happens to
 * run — including the seeded placeholder organization itself, `"Phase One Foodservice"`.
 *
 * The fix is the same one `_loadSwitcherOrganizations`/`_loadAllOrganizations` already rely on
 * for their own unit tests: give these organizations a name that sorts ahead of anything an
 * ordinary fixture would use. Every other organization in this suite has a letter-led name (a
 * human-readable one, `Test org <uuid>`, or the seeded placeholder), so no letter can promise
 * "always first" — some other name, present or future, is free to start earlier in the alphabet.
 * A leading digit can promise that, since it sorts before every letter, so these are named like a
 * real digit-led foodservice chain — `"24/7 …"` — rather than with a bare, test-only-looking
 * prefix.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';
import { stubOrganizationsAsEmpty } from '../lib/stub-page-data.ts';

// Both tests below use a "24/7 "-prefixed name to dominate the sort order (see the file doc
// comment above), which only keeps *other* specs out — nothing stops these two tests' own
// "24/7 "-prefixed organizations from interleaving with each other if they ran at once. Serial
// keeps this file's fixtures fully torn down before the next test's are created.
test.describe.configure({ mode: 'serial' });

test('the full switcher, past the cap', async ({ page, organizationMemberships }) => {
  // Nine names, one past `_SWITCHER_LIMIT`, so the menu offers "View all organizations". The
  // navigated-to one sorts *last* of the nine, which puts it outside the server's own first-eight
  // slice — the case where `current` is pinned to the top of the menu by the component alone.
  const names = [
    '24/7 Switcher Riverside Foods', // navigated to below, so this is "current"
    '24/7 Switcher Acme Foodservice',
    '24/7 Switcher Bakers Row',
    '24/7 Switcher Cedar Grove Dining',
    '24/7 Switcher Dockside Catering',
    '24/7 Switcher Elmwood Kitchens',
    '24/7 Switcher Fairview Foodservice',
    '24/7 Switcher Grovemont Catering',
    '24/7 Switcher Harborview Foods',
  ];
  const [currentId] = await Promise.all(
    names.map((name) => organizationMemberships.create({ name })),
  );

  await page.goto(`/orgs/${currentId}`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Switch organization' }).click();
  await expect(page.getByRole('menuitem', { name: 'View all organizations' })).toBeVisible();

  // Hover one row so the committed image also shows the hover affordance.
  await page.getByRole('menuitem', { name: '24/7 Switcher Bakers Row' }).hover();

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

  // Hover one row so the committed image also shows the hover affordance.
  await page.getByRole('link', { name: '24/7 List Cedar Grove Dining' }).hover();
  await expectScreenshots(page, 'orgs-list.png', { clipBelow: lastRow });
});

test('the /orgs list, empty', async ({ page, organizationMemberships }) => {
  // A letter-led name is fine here, unlike the two tests above: this list is stubbed empty before
  // it's captured, so there is no sort order of real rows to defend against other specs'.
  const name = 'Waypoint Foodservice';
  await organizationMemberships.create({ name });

  await page.goto('/orgs');
  await ensureHydrated(page);
  await stubOrganizationsAsEmpty(page);

  // Into an organization and back out again — the only way to trigger the client-side navigation
  // that `stubOrganizationsAsEmpty` waits for (see its doc comment). The org page's own heading
  // is just "Reports"; the switcher is what still names the organization, so that's the proof
  // navigation landed on the right one.
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('button', { name: 'Switch organization' })).toContainText(name);
  await page.goBack();

  await expect(page.getByText('No organizations yet.')).toBeVisible();
  await expect(page.getByRole('link', { name })).toHaveCount(0);
  await expectScreenshots(page, 'orgs-list-empty.png');
});
