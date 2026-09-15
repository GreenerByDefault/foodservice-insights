/** Nine committed images.
 *
 * `members-as-admin.png` and `members-as-member.png` are one roster seen by each of the two
 * viewer roles — both roles among the people listed, and both name shapes a row renders: a
 * display name with the email beneath, and a display name-less row that shows only the email.
 * The pair is what shows the admin-only controls are admin-only: the per-row "⋯" menus are in
 * the first and gone from the second, and the "Your membership" section holds Step down + Leave
 * for the admin image but Leave alone for the member one. `members-as-admin.png` also carries the
 * admin-only invites section — one live invite and one expired, plus the invite form — since that
 * section is admin-only the same way the per-row menus are.
 *
 * `members-menu.png` is a row's menu open — where that menu lands against the row it belongs to,
 * which a roster image can't show — now with Remove from organization below the role toggle.
 * `members-remove-confirm.png` continues one step further: the menu's "Remove from organization"
 * item opens `ConfirmAction`'s dialog, not its own trigger, so this is the one place that path —
 * and the member's name interpolated into the dialog's title — renders. The dialog's own chrome
 * (loading, error banner) is generic across every `ConfirmAction` call site and already covered by
 * `members-step-down-refused.png`, so this image isn't re-proving that.
 * `members-step-down-refused.png` is the "Your membership" section's refused Step down, the one
 * action that acts on the viewer rather than another row.
 *
 * `members-invite-refused.png`, `members-invite-rate-limited.png`, and
 * `members-invite-email-failed.png` are the invite form's own three non-happy outcomes — inline
 * "already a member", the 429 alert, and the "sent but not emailed" warning — none of which
 * `members-as-admin.png` can show since it's mid-invite, not post-submit. The rate-limit and
 * email-failed cases are routed rather than actually hit (sending real mail 20 times, or breaking
 * the emailer, just to render one alert), the same way a network failure is faked elsewhere in
 * this suite rather than actually cut. `members-invite-revoke-failed.png` is the pending-invite
 * row's own error banner, the Revoke counterpart to `members-remove-confirm.png`'s dialog chrome —
 * this list has no dialog to reuse that from, since Revoke has none.
 *
 * Every person's email is fixed rather than the fixture's default random one: unlike a
 * behavioural spec, which only asserts a row exists, these are diffed pixel-for-pixel against
 * what's committed, so the text on screen has to be identical on every run. Every image here owns
 * a separate address prefix, so none depends on identities another is creating alongside it.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { DAY_MS, HOUR_MS } from '@gbd/core';
import { dbMsAgo, dbMsFromNow } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { organizationInvitesApiHref } from '../../src/lib/hrefs.ts';
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
    invites: [
      // Well within a week, so `formatUntil` reads relative — "in 3 days" rather than an
      // absolute date, the same discipline `reports-list.screenshot.ts` follows for the past.
      // The extra 12 hours keeps it clear of the day boundary: without it, the few seconds
      // between this insert and the page's own `now()` read floor the count down to 2.
      {
        email: 'members-screenshot-live@example.test',
        role: 'member',
        expiresAt: dbMsFromNow(3 * DAY_MS + 12 * HOUR_MS),
      },
      {
        email: 'members-screenshot-expired@example.test',
        role: 'admin',
        expiresAt: dbMsAgo(DAY_MS),
      },
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
  // Own-row actions live in "Your membership" below the list, not in a menu on the row itself.
  await expect(page.getByRole('button', { name: 'Step down as admin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave organization' })).toBeVisible();

  await expect(page.getByText('Pending invitations')).toBeVisible();
  const liveInviteRow = page
    .getByRole('listitem')
    .filter({ hasText: 'members-screenshot-live@example.test' });
  await expect(liveInviteRow.getByText('in 3 days', { exact: false })).toBeVisible();
  const expiredInviteRow = page
    .getByRole('listitem')
    .filter({ hasText: 'members-screenshot-expired@example.test' });
  // A plain string match is case-insensitive, which would also match the row's own
  // "…-expired@example.test" address — a regex without the `i` flag isn't.
  await expect(expiredInviteRow.getByText(/Expired/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();

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
  // No row offers a menu, not even their own — the admin-only "⋯".
  await expect(page.getByRole('button', { name: /^Manage / })).toHaveCount(0);
  // "Your membership" holds Leave alone: no Step down, since the viewer isn't an admin here.
  await expect(page.getByRole('button', { name: 'Step down as admin' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave organization' })).toBeVisible();

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
  await expect(page.getByRole('menuitem', { name: 'Remove from organization' })).toBeVisible();

  // Hover it so the committed image also shows the hover affordance, and so the pointer isn't
  // left sitting on the trigger it just clicked.
  await page.getByRole('menuitem', { name: 'Make admin' }).hover();

  await expectScreenshots(page, 'members-menu.png');
});

test('a member row’s Remove from organization, confirming', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Remove Confirm Screenshot Foodservice',
    members: [
      { displayName: 'Ana Ruiz', email: 'members-remove-confirm-ana@example.test', role: 'member' },
    ],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Manage Ana Ruiz' }).click();
  await page.getByRole('menuitem', { name: 'Remove from organization' }).click();

  await expect(page.getByRole('heading', { name: 'Remove Ana Ruiz?' })).toBeVisible();
  await expect(
    page.getByText("They'll lose access to this organization's reports and files."),
  ).toBeVisible();

  await expectScreenshots(page, 'members-remove-confirm.png');
});

test('the sole admin’s Your membership section, after Step down is refused', async ({
  page,
  organizations,
}) => {
  // No `members` given: the signed-in user is this organization's creator and only member, so
  // stepping down is the one action `your-membership.svelte` refuses client-side-visibly.
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Error Screenshot Foodservice',
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Step down as admin' }).click();
  await page.getByRole('button', { name: 'Yes, step down' }).click();

  await expect(
    page.getByText("You're the only admin. Make someone else an admin first."),
  ).toBeVisible();

  await expectScreenshots(page, 'members-step-down-refused.png');
});

test('inviting an existing member is refused inline', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Refused Screenshot Foodservice',
    members: [
      {
        displayName: 'Ana Ruiz',
        email: 'members-invite-refused-ana@example.test',
        role: 'member',
      },
    ],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByLabel('Email address').fill('members-invite-refused-ana@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(page.getByText('That person is already a member.')).toBeVisible();

  await expectScreenshots(page, 'members-invite-refused.png');
});

test('the invite form’s rate-limit alert', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Rate Limited Screenshot Foodservice',
  });

  await page.route(`**${organizationInvitesApiHref(organizationSlug)}`, (route) =>
    route.fulfill({
      status: 429,
      json: {
        message: "You've sent too many invites. Try again in an hour.",
        code: 'rate-limited',
      },
    }),
  );

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByLabel('Email address').fill('members-invite-rate-limited@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(
    page.getByRole('alert').filter({ hasText: "You've sent too many invites." }),
  ).toBeVisible();

  await expectScreenshots(page, 'members-invite-rate-limited.png');
});

test('an invite that saved but couldn’t be emailed', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Email Failed Screenshot Foodservice',
  });

  await page.route(`**${organizationInvitesApiHref(organizationSlug)}`, (route) =>
    route.fulfill({ status: 201, json: { inviteId: crypto.randomUUID(), emailSent: false } }),
  );

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByLabel('Email address').fill('members-invite-email-failed@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(
    page.getByText("Saved, but the email couldn't be sent — try inviting them again."),
  ).toBeVisible();

  await expectScreenshots(page, 'members-invite-email-failed.png');
});

test('revoking an invite, refused', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Revoke Failed Screenshot Foodservice',
    invites: [{ email: 'members-invite-revoke-failed@example.test', role: 'member' }],
  });

  await page.route(`**${organizationInvitesApiHref(organizationSlug)}/*`, (route) =>
    route.fulfill({ status: 404, json: { message: 'Not found', code: 'not_found' } }),
  );

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Revoke', exact: true }).click();

  await expect(page.getByText('Could not revoke this invite. Please try again.')).toBeVisible();

  await expectScreenshots(page, 'members-invite-revoke-failed.png');
});
