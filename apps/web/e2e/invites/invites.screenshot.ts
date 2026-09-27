/** `invites.png` is one live offer and one expired, the two shapes a card takes; `invites-empty.png`
 * is the page with nothing waiting. `invites-accept-failed.png` is a card's error line, routed
 * rather than actually hit, as `members.screenshot.ts` does for Revoke — Decline and Dismiss render
 * the same line, so this one image covers all three.
 *
 * The invitee is a second person, minted by `users`, rather than the test's own user: that user is
 * the one `organizations.create` puts in every organization it makes. No image renders the
 * invitee's address, so a minted one is fine. Organization names and the inviter's display name are
 * fixed instead, since both are on screen.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { DAY_MS, HOUR_MS } from '@gbd/core';
import { dbMsAgo, dbMsFromNow } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('one live invitation and one expired', async ({ organizations, users }) => {
  const invitee = await users.create();
  await organizations.create({
    name: 'Invites Screenshot Harbor Foods',
    // A member, so that `admin` — and not the test's own, unnamed user — sent the invite.
    role: 'member',
    admin: { displayName: 'Priya Shah', email: 'invites-screenshot-admin@example.test' },
    // The extra 12 hours keeps "in 3 days" clear of the day boundary, as in
    // `members.screenshot.ts`.
    invites: [{ email: invitee.email, expiresAt: dbMsFromNow(3 * DAY_MS + 12 * HOUR_MS) }],
  });
  await organizations.create({
    name: 'Invites Screenshot Cedar Grove Dining',
    invites: [{ email: invitee.email, expiresAt: dbMsAgo(2 * DAY_MS + 12 * HOUR_MS) }],
  });
  const page = await (await users.contextFor(invitee)).newPage();

  await page.goto('/invites');
  await ensureHydrated(page);

  await expect(page.getByText('Priya Shah invited you to join as a member.')).toBeVisible();
  await expect(page.getByText('Expires in 3 days')).toBeVisible();
  await expect(page.getByText(/Your invitation expired 2 days ago/)).toBeVisible();

  await expectScreenshots(page, 'invites.png');
});

test('accepting an invitation, failed', async ({ organizations, users }) => {
  const invitee = await users.create();
  const name = 'Invites Accept Failed Screenshot Foodservice';
  await organizations.create({
    name,
    role: 'member',
    admin: { displayName: 'Priya Shah', email: 'invites-accept-failed-admin@example.test' },
    invites: [{ email: invitee.email, expiresAt: dbMsFromNow(3 * DAY_MS + 12 * HOUR_MS) }],
  });
  const context = await users.contextFor(invitee);
  await context.route('**/api/invites/*/accept', (route) =>
    route.fulfill({ status: 500, json: { message: 'Internal Error' } }),
  );
  const page = await context.newPage();

  await page.goto('/invites');
  await ensureHydrated(page);

  await page.getByRole('button', { name: `Accept invitation to ${name}` }).click();
  await expect(page.getByText("Couldn't accept this invitation — please try again.")).toBeVisible();

  await expectScreenshots(page, 'invites-accept-failed.png');
});

test('no invitations waiting', async ({ page }) => {
  await page.goto('/invites');
  await ensureHydrated(page);

  await expect(page.getByText('No invitations waiting.')).toBeVisible();

  await expectScreenshots(page, 'invites-empty.png');
});
