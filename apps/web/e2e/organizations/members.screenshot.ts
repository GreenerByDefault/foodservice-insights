/** Four committed images.
 *
 * `members-as-admin.png` and `members-as-member.png` are one roster seen by each of the two
 * viewer roles — both roles among the people listed, and both name shapes a row renders: a
 * display name with the email beneath, and a display name-less row that shows only the email.
 * The pair is what shows the admin-only controls are admin-only: the "⋯" menus and the note
 * under the list are in the first and gone from the second.
 *
 * `members-menu.png` is a row's menu open — where that menu lands against the row it belongs to,
 * which a roster image can't show. `members-error.png` is a refused action's message, which
 * takes a full-width line below the row rather than crowding the name and the menu off it.
 *
 * Every person's email is fixed rather than the fixture's default random one: unlike a
 * behavioural spec, which only asserts a row exists, these are diffed pixel-for-pixel against
 * what's committed, so the text on screen has to be identical on every run. The two roster
 * images own separate addresses, so neither depends on identities the other is creating
 * alongside it.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import type { OrganizationAdminSpec, OrganizationMemberSpec } from '../fixtures/organizations.ts';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

/** The three people both roster images show around the viewer. Which of them is the
 * *organization's* admin depends on the role the viewer holds, so that one comes back on its own
 * rather than in the member list. */
function roster(prefix: string): {
  admin: OrganizationAdminSpec;
  members: OrganizationMemberSpec[];
} {
  return {
    admin: { displayName: 'Priya Shah', email: `${prefix}-admin@example.test` },
    members: [
      { displayName: 'Ana Ruiz', email: `${prefix}-ana@example.test`, role: 'member' },
      { email: `${prefix}-noname@example.test`, role: 'member' },
    ],
  };
}

test('the roster as an admin, the viewer among them', async ({ page, organizations }) => {
  const { admin, members } = roster('members-screenshot');
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Screenshot Foodservice',
    // The viewer creates and admins this one, so the roster's own admin joins as a second one.
    members: [{ ...admin, role: 'admin' }, ...members],
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

  await expectScreenshots(page, 'members-as-admin.png');
});

test('the roster as a member, who administers none of it', async ({ page, organizations }) => {
  const { admin, members } = roster('members-as-member');
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members As Member Screenshot Foodservice',
    // The viewer joins as a member, so `admin` is who creates and administers it instead.
    role: 'member',
    admin,
    members,
  });

  await page.goto(`/orgs/${organizationSlug}/members`);

  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByText('Priya Shah', { exact: true })).toBeVisible();
  await expect(page.getByText('(You)')).toBeVisible();
  // Both of the things the viewer's role gates: no row offers a menu, not even their own, and
  // the note under the list is the admin's too.
  await expect(page.getByRole('button', { name: /^Manage / })).toHaveCount(0);
  await expect(page.getByText('Inviting and removing people arrives later.')).toHaveCount(0);

  await expectScreenshots(page, 'members-as-member.png');
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

test('the sole admin’s own row, after Make member is refused', async ({
  page,
  organizations,
  user,
}) => {
  // No `members` given: the signed-in user is this organization's creator and only member, so
  // demoting their own row is the one action `member-actions.svelte` refuses client-side-visibly.
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Error Screenshot Foodservice',
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: `Manage ${user.email}` }).click();
  await page.getByRole('menuitem', { name: 'Make member' }).click();

  await expect(
    page.getByText("You're the only admin. Make someone else an admin first."),
  ).toBeVisible();

  await expectScreenshots(page, 'members-error.png');
});
