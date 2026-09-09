/** One committed image, mixing both roles and both name shapes the row renders: a display name
 * with the email beneath, and a display name-less row that shows only the email. Every person's
 * email is fixed rather than the fixture's default random one — unlike a behavioural spec, which
 * only asserts a row exists, this image is diffed pixel-for-pixel against what's committed, so
 * the text on screen has to be identical on every run.
 */

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
