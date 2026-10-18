/** Every person's email is fixed rather than the fixture's default random one: unlike a
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

// The viewer's own row is on the roster too, so it has to be the same person on every run.
test.use({ identity: 'pinned' });

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
      // No display name, the other shape a row renders: the email alone.
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

  await expect(page.getByRole('heading', { name: 'Organization members' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Invite someone' })).toBeVisible();

  await expectScreenshots(page, 'as-admin.png');
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

  await expect(page.getByRole('heading', { name: 'Organization members' })).toBeVisible();
  await expect(page.getByText('Priya Shah', { exact: true })).toBeVisible();
  await expect(page.getByText('(You)')).toBeVisible();
  // No row offers a menu, not even their own — the admin-only "⋯".
  await expect(page.getByRole('button', { name: /^Manage / })).toHaveCount(0);
  // "Your membership" holds Leave alone: no Step down, since the viewer isn't an admin here.
  await expect(page.getByRole('button', { name: 'Step down as admin' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave organization' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);

  await expectScreenshots(page, 'as-member.png');
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

  // Where the menu lands against its row, which a roster image can't show.
  await expectScreenshots(page, 'menu.png');
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

  // A menu item, not a trigger of its own, opens this `ConfirmAction` — the one place that path
  // renders. The dialog's loading and error chrome is the same everywhere, and
  // `step-down-refused.png` already covers it.
  await page.getByRole('button', { name: 'Manage Ana Ruiz' }).click();
  await page.getByRole('menuitem', { name: 'Remove from organization' }).click();

  await expect(page.getByRole('heading', { name: 'Remove Ana Ruiz?' })).toBeVisible();
  await expect(
    page.getByText("They'll lose access to this organization's reports and files."),
  ).toBeVisible();

  await expectScreenshots(page, 'remove-confirm.png');
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

  await expectScreenshots(page, 'step-down-refused.png');
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

  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByLabel('Email address').fill('members-invite-refused-ana@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(page.getByText('That person is already a member.')).toBeVisible();

  // Between them, the three invite images show the dialog's whole form, so none shows it empty.
  await expectScreenshots(page, 'invite-refused.png');
});

test('the invite dialog’s rate-limit alert', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Rate Limited Screenshot Foodservice',
  });

  // Routed: actually hitting the limit would send 20 real emails.
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

  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByLabel('Email address').fill('members-invite-rate-limited@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(
    page.getByRole('alert').filter({ hasText: "You've sent too many invites." }),
  ).toBeVisible();

  await expectScreenshots(page, 'invite-rate-limited.png');
});

test('an invite that saved but couldn’t be emailed', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Invite Email Failed Screenshot Foodservice',
  });

  // Routed rather than breaking the emailer.
  await page.route(`**${organizationInvitesApiHref(organizationSlug)}`, (route) =>
    route.fulfill({ status: 201, json: { inviteId: crypto.randomUUID(), emailSent: false } }),
  );

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Invite someone' }).click();
  await page.getByLabel('Email address').fill('members-invite-email-failed@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(
    page.getByText("They're invited, but we couldn't email them. Send the invite again to retry."),
  ).toBeVisible();

  await expectScreenshots(page, 'invite-email-failed.png');
});

test('canceling an invite, refused', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Members Cancel Invite Failed Screenshot Foodservice',
    invites: [
      {
        email: 'members-cancel-invite-failed@example.test',
        role: 'member',
        // Well within a week, so `formatUntil` reads relative — "in 3 days" — rather than an
        // absolute date. Left at the default `INVITE_LIFETIME_DAYS` (14 days out), the row would
        // render an absolute date that shifts with the calendar, un-diffable against a committed
        // image on any day but the one it was captured.
        expiresAt: dbMsFromNow(3 * DAY_MS + 12 * HOUR_MS),
      },
    ],
  });

  await page.route(`**${organizationInvitesApiHref(organizationSlug)}/*`, (route) =>
    route.fulfill({ status: 404, json: { message: 'Not found', code: 'not_found' } }),
  );

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page
    .getByRole('button', { name: 'Cancel invite for members-cancel-invite-failed@example.test' })
    .click();

  await expect(page.getByText("Couldn't cancel this invite — please try again.")).toBeVisible();

  await expectScreenshots(page, 'cancel-invite-failed.png');
});
