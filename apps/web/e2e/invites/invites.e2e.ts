/** The invitee's side: the test's own user is the admin who invited them, and `users` mints the
 * invitee, so nothing here is visible to any other spec's `/orgs`. */

import { ensureHydrated } from '@gbd/browser-testing';
import { DAY_MS } from '@gbd/core';
import { dbMsAgo } from '@gbd/db/testing';
import { waitForEmail } from '@gbd/email/testing';
import { expect } from '@playwright/test';
import { organizationHref, organizationMembersHref } from '../../src/lib/hrefs.ts';
import { test } from '../fixtures/test.ts';
import { waitForSignInCode } from '../lib/sign-in-code.ts';

test('an invitee is forwarded to /invites, accepts, and lands in the organization', async ({
  organizations,
  users,
}) => {
  const invitee = await users.create();
  const name = `Invitee Accepts ${crypto.randomUUID()}`;
  const { slug } = await organizations.create({ name, invites: [{ email: invitee.email }] });
  const page = await (await users.contextFor(invitee)).newPage();

  await page.goto('/orgs');
  await expect(page).toHaveURL('/invites');
  await ensureHydrated(page);

  await page.getByRole('button', { name: `Accept invitation to ${name}` }).click();
  await expect(page).toHaveURL(organizationHref(slug));

  await page.goto(organizationMembersHref(slug));
  await expect(page.getByRole('listitem').filter({ hasText: invitee.email })).toContainText(
    '(You)',
  );
});

test('the invite email signs the invitee in with their address filled in, and lands on the offer', async ({
  page,
  browser,
  baseURL,
  organizations,
  users,
}) => {
  const invitee = await users.create();
  const name = `Invitee Signs In ${crypto.randomUUID()}`;
  const { slug } = await organizations.create({ name });

  // Invited through the page rather than the fixture's `invites`, which sends no email.
  await page.goto(organizationMembersHref(slug));
  await ensureHydrated(page);
  await page.getByLabel('Email address').fill(invitee.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  const link = /\S+\/sign-in\?email=\S+/.exec((await waitForEmail(invitee.email)).text)?.[0];
  if (link === undefined) throw new Error('The invite email carries no sign-in link');
  // The link's origin is `SITE_URL`, which need not be this run's port.
  const { pathname, search } = new URL(link);

  const context = await browser.newContext({ baseURL });
  try {
    const inviteePage = await context.newPage();
    await inviteePage.goto(pathname + search);
    await ensureHydrated(inviteePage);

    await expect(inviteePage.getByLabel('Email address')).toHaveValue(invitee.email);
    await inviteePage.getByRole('button', { name: 'Send code' }).click();
    await inviteePage.getByLabel('Sign-in code').fill(await waitForSignInCode(invitee.signInEmail));

    await expect(inviteePage).toHaveURL('/invites');
    await expect(
      inviteePage.getByRole('button', { name: `Accept invitation to ${name}` }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('declining empties the page, and /orgs stops forwarding', async ({ organizations, users }) => {
  const invitee = await users.create();
  const name = `Invitee Declines ${crypto.randomUUID()}`;
  await organizations.create({ name, invites: [{ email: invitee.email }] });
  const page = await (await users.contextFor(invitee)).newPage();

  await page.goto('/invites');
  await ensureHydrated(page);

  await page.getByRole('button', { name: `Decline invitation to ${name}` }).click();
  await expect(page.getByText('No invitations waiting.')).toBeVisible();

  // Belonging to nothing, the invitee is sent to create an organization instead.
  await page.goto('/orgs');
  await expect(page).toHaveURL('/orgs/new');
});

test('an expired invite never forwards, and Dismiss clears it', async ({
  db,
  organizations,
  users,
}) => {
  const invitee = await users.create();
  const name = `Invitee Dismisses ${crypto.randomUUID()}`;
  const { id: organizationId } = await organizations.create({
    name,
    invites: [{ email: invitee.email, expiresAt: dbMsAgo(DAY_MS) }],
  });
  const page = await (await users.contextFor(invitee)).newPage();

  await page.goto('/orgs');
  await expect(page).toHaveURL('/orgs/new');

  await page.goto('/invites');
  await ensureHydrated(page);
  await expect(page.getByText(/Your invitation expired/)).toBeVisible();

  await page.getByRole('button', { name: `Dismiss invitation to ${name}` }).click();
  await expect(page.getByText('No invitations waiting.')).toBeVisible();

  const invite = await db
    .selectFrom('organizationInvite')
    .select('status')
    .where('organizationId', '=', organizationId)
    .executeTakeFirstOrThrow();
  expect(invite.status).toBe('expired');
});
