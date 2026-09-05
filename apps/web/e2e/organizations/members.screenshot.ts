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
  const organizationId = await organizations.create({
    name: 'Members Screenshot Foodservice',
    members: [
      { displayName: 'Priya Shah', email: 'members-screenshot-admin@example.test', role: 'admin' },
      { displayName: 'Ana Ruiz', email: 'members-screenshot-ana@example.test', role: 'member' },
      { email: 'members-screenshot-noname@example.test', role: 'member' },
    ],
  });

  await page.goto(`/orgs/${organizationId}/members`);

  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByText('Priya Shah')).toBeVisible();
  await expect(page.getByText('Ana Ruiz')).toBeVisible();
  await expect(page.getByText('members-screenshot-noname@example.test')).toBeVisible();
  // The placeholder is this organization's creator and admin, so it's the row naming "You".
  await expect(page.getByText('(You)')).toBeVisible();

  await expectScreenshots(page, 'members.png');
});
