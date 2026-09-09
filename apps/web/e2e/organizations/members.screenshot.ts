/** Two committed images.
 *
 * The first mixes both roles and both name shapes the row renders: a display name with the
 * email beneath, and a display name-less row that shows only the email. Every person's email is
 * fixed rather than the fixture's default random one — unlike a behavioural spec, which only
 * asserts a row exists, this image is diffed pixel-for-pixel against what's committed, so the
 * text on screen has to be identical on every run.
 *
 * The second is a row's "⋯" menu open — where that menu lands against the row it belongs to,
 * which the first image can't show. Only the ordinary case is worth an image: the last admin's
 * own row differs from this one by the sentence it answers a click with, and a sentence is
 * something `members.e2e.ts` asserts precisely and a pixel diff only approximates.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('a mix of roles and both name shapes, the viewer among them', async ({
  page,
  organizations,
}) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Screenshot Foodservice',
    members: [
      { displayName: 'Priya Shah', email: 'members-screenshot-admin@example.test', role: 'admin' },
      { displayName: 'Ana Ruiz', email: 'members-screenshot-ana@example.test', role: 'member' },
      { email: 'members-screenshot-noname@example.test', role: 'member' },
    ],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);

  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  // `exact: true`, since each row's own "⋯" menu carries a sr-only "Manage {name}" label that
  // would otherwise also match a plain substring search.
  await expect(page.getByText('Priya Shah', { exact: true })).toBeVisible();
  await expect(page.getByText('Ana Ruiz', { exact: true })).toBeVisible();
  await expect(
    page.getByText('members-screenshot-noname@example.test', { exact: true }),
  ).toBeVisible();
  // The signed-in user is this organization's creator and admin, so it's the row naming "You".
  await expect(page.getByText('(You)')).toBeVisible();

  await expectScreenshots(page, 'members.png');
});

test('a member row’s menu, open', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Menu Screenshot Foodservice',
    members: [{ displayName: 'Ana Ruiz', email: 'members-menu-ana@example.test', role: 'member' }],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Manage Ana Ruiz' }).click();
  await expect(page.getByRole('menuitem', { name: 'Make admin' })).toBeVisible();

  // Hover it so the committed image also shows the hover affordance, and so the pointer isn't
  // left sitting on the trigger it just clicked.
  await page.getByRole('menuitem', { name: 'Make admin' }).hover();

  await expectScreenshots(page, 'members-menu.png');
});
