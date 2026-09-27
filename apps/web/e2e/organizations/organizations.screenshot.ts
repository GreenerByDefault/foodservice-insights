/** The switcher and `/orgs` both show *every* organization the signed-in user belongs to, with
 * no `/orgs/<slug>` of their own to scope a fixture to — unlike every other screenshot in this
 * suite, which renders inside one dedicated organization (see `reports-list.screenshot.ts`).
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';
import { stubOrganizationsAsEmpty } from '../lib/stub-page-data.ts';

test('the full switcher, past the cap', async ({ page, organizations }) => {
  // Nine names, one past `SWITCHER_LIMIT`, so the menu offers "View all organizations". The
  // navigated-to one sorts *last* of the nine, which puts it outside the server's own first-eight
  // slice — the case where `current` is pinned to the top of the menu by the component alone.
  const names = [
    'Switcher Riverside Foods', // navigated to below, so this is "current"
    'Switcher Acme Foodservice',
    'Switcher Bakers Row',
    'Switcher Cedar Grove Dining',
    'Switcher Dockside Catering',
    'Switcher Elmwood Kitchens',
    'Switcher Fairview Foodservice',
    'Switcher Grovemont Catering',
    'Switcher Harborview Foods',
  ];
  const [current] = await Promise.all(
    names.map((name) => organizations.create({ name, role: 'member' })),
  );

  await page.goto(`/orgs/${current.slug}`);
  await ensureHydrated(page);

  // `role: 'member'` above now does double duty: besides keeping the signed-in user from being
  // these organizations' sole member, this is the only committed image proving a member's nav
  // has two tabs, not three.
  await page.getByRole('button', { name: 'Switch organization' }).click();
  await expect(page.getByRole('menuitem', { name: 'View all organizations' })).toBeVisible();

  // Hover one row so the committed image also shows the hover affordance.
  await page.getByRole('menuitem', { name: 'Switcher Bakers Row' }).hover();

  await expectScreenshots(page, 'organization-switcher.png');
});

test('the /orgs list, past eight organizations', async ({ page, organizations }) => {
  // Already alphabetical, so the last name here is also the last row on the page — the one
  // `expectScreenshots` crops the capture against (see its `clipBelow` doc comment).
  const names = [
    'List Acme Foodservice',
    'List Bakers Row',
    'List Cedar Grove Dining',
    'List Dockside Catering',
    'List Elmwood Kitchens',
    'List Fairview Foodservice',
    'List Grovemont Catering',
    'List Harborview Foods',
    'List Ivywood Catering',
  ];
  await Promise.all(names.map((name) => organizations.create({ name, role: 'member' })));

  await page.goto('/orgs');
  await ensureHydrated(page);

  const lastRow = page.getByRole('link', { name: names.at(-1) });
  await expect(lastRow).toBeVisible();

  // Hover one row so the committed image also shows the hover affordance.
  await page.getByRole('link', { name: 'List Cedar Grove Dining' }).hover();
  await expectScreenshots(page, 'list.png', { clipBelow: lastRow });
});

test('the /orgs list, empty', async ({ page, organizations }) => {
  // A letter-led name is fine here, unlike the two tests above: this list is stubbed empty before
  // it's captured, so there is no sort order of real rows to defend against other specs'. Two of
  // them, because `/orgs` redirects a user with one organization straight into it.
  const name = 'Waypoint Foodservice';
  await organizations.create({ name, role: 'member' });
  await organizations.create({ name: 'Wayside Foodservice', role: 'member' });

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
  await expectScreenshots(page, 'list-empty.png');
});
