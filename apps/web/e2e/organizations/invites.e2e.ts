import { ensureHydrated } from '@gbd/browser-testing';
import { aTestEmailAddress, waitForEmail } from '@gbd/email/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('an admin invites someone, sees the row appear, then revokes it — no reload either way', async ({
  page,
  organizations,
}) => {
  const invitee = aTestEmailAddress('invites-e2e-invitee');
  const { slug: organizationSlug } = await organizations.create({
    name: `Invites ${crypto.randomUUID()}`,
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await page.getByLabel('Email address').fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  const row = page.getByRole('main').getByRole('listitem').filter({ hasText: invitee });
  await expect(row).toBeVisible();
  await expect(row.getByText('Member')).toBeVisible();
  // The field clears on success, ready for the next address.
  await expect(page.getByLabel('Email address')).toHaveValue('');

  const email = await waitForEmail(invitee);
  expect(email.subject).toContain('Join');
  expect(email.text).toMatch(/\/sign-in\?email=/);

  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);

  expect(loads.count).toBe(0);
});

test('re-inviting an outstanding address still shows one row', async ({ page, organizations }) => {
  const invitee = aTestEmailAddress('invites-e2e-reinvite');
  const { slug: organizationSlug } = await organizations.create({
    name: `Reinvite ${crypto.randomUUID()}`,
    invites: [{ email: invitee, role: 'member' }],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await expect(
    page.getByRole('main').getByRole('listitem').filter({ hasText: invitee }),
  ).toHaveCount(1);

  await page.getByLabel('Email address').fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  // The toast is raised only after the list has been re-fetched, so the count below is of the
  // re-invited list, not the pre-click one that already had one row. It also keeps the test from
  // ending while the re-invite's transaction still holds the invite row: the fixture's teardown
  // then deletes the organization, whose cascade waits on that row while the re-invite's insert
  // waits on the organization row — a deadlock.
  await expect(page.getByText(`Invited ${invitee}`)).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('listitem').filter({ hasText: invitee }),
  ).toHaveCount(1);
});

test('inviting an existing member is refused inline', async ({ page, organizations }) => {
  const existingMemberEmail = `invites-e2e-existing-${crypto.randomUUID()}@example.test`;
  const { slug: organizationSlug } = await organizations.create({
    name: `Existing Member ${crypto.randomUUID()}`,
    members: [{ email: existingMemberEmail, role: 'member' }],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByLabel('Email address').fill(existingMemberEmail);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await expect(page.getByText('That person is already a member.')).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('listitem').filter({ hasText: existingMemberEmail }),
  ).toHaveCount(1);
});

test('a member sees no invite form or pending list', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: `Member View ${crypto.randomUUID()}`,
    role: 'member',
  });

  await page.goto(`/orgs/${organizationSlug}/members`);

  await expect(page.getByText('Pending invitations')).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toHaveCount(0);
});
