import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { organizationMemberApiHref } from '../../src/lib/hrefs.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('an admin promotes a member to admin, then demotes them back, with no reload either way', async ({
  page,
  organizations,
}) => {
  const memberName = 'Priya Shah';
  const { slug: organizationSlug } = await organizations.create({
    name: `Promotion Foodservice ${crypto.randomUUID()}`,
    members: [{ displayName: memberName, role: 'member' }],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  const memberRow = page.getByRole('listitem').filter({ hasText: memberName });
  await expect(memberRow.getByText('Member')).toBeVisible();

  const loads = watchPageLoads(page);

  await memberRow.getByRole('button', { name: `Manage ${memberName}` }).click();
  await page.getByRole('menuitem', { name: 'Make admin' }).click();
  await expect(memberRow.getByText('Admin')).toBeVisible();

  await memberRow.getByRole('button', { name: `Manage ${memberName}` }).click();
  await page.getByRole('menuitem', { name: 'Make member' }).click();
  await expect(memberRow.getByText('Member')).toBeVisible();

  expect(loads.count).toBe(0);
});

test('the sole admin stepping down is refused, and told how to proceed', async ({
  page,
  organizations,
  user,
}) => {
  const { slug: organizationSlug } = await organizations.create({
    name: `Sole Admin Foodservice ${crypto.randomUUID()}`,
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  const ownRow = page.getByRole('listitem').filter({ hasText: user.email });

  await page.getByRole('button', { name: 'Step down as admin' }).click();
  await page.getByRole('button', { name: 'Yes, step down' }).click();

  await expect(
    page.getByText("You're the only admin. Make someone else an admin first."),
  ).toBeVisible();
  // The trigger refused, so the role on screen is unchanged. `exact: true`, or this also matches
  // the "only admin" in the alert above — `getByText` is a case-insensitive substring match.
  await expect(ownRow.getByText('Admin', { exact: true })).toBeVisible();
});

test('an admin removes a member, and the row disappears', async ({ page, organizations }) => {
  const memberName = 'Priya Shah';
  const { slug: organizationSlug } = await organizations.create({
    name: `Removal Foodservice ${crypto.randomUUID()}`,
    members: [{ displayName: memberName, role: 'member' }],
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  const memberRow = page.getByRole('listitem').filter({ hasText: memberName });
  await memberRow.getByRole('button', { name: `Manage ${memberName}` }).click();
  await page.getByRole('menuitem', { name: 'Remove from organization' }).click();
  await page.getByRole('button', { name: 'Yes, remove' }).click();

  await expect(memberRow).toHaveCount(0);
});

test('a member leaves via the button and lands on /orgs or a remaining organization', async ({
  page,
  organizations,
}) => {
  const { slug: organizationSlug } = await organizations.create({
    name: `Leaving Foodservice ${crypto.randomUUID()}`,
    role: 'member',
    admin: { displayName: 'Priya Shah' },
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Leave organization' }).click();
  await page.getByRole('button', { name: 'Yes, leave' }).click();

  // Same branch as delete-organization.e2e.ts: `_organizationsPageRedirect` forwards `/orgs` to a
  // single remaining organization when there is one.
  await page.waitForURL((url) => !url.pathname.includes(organizationSlug));
  if (new URL(page.url()).pathname !== '/orgs') {
    await expect(page.getByRole('button', { name: 'Switch organization' })).not.toContainText(
      organizationSlug,
    );
  }
});

test('the only admin leaving is refused, and the organization is still there', async ({
  page,
  organizations,
}) => {
  const { slug: organizationSlug } = await organizations.create({
    name: `Sole Admin Leaving Foodservice ${crypto.randomUUID()}`,
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Leave organization' }).click();
  await page.getByRole('button', { name: 'Yes, leave' }).click();

  await expect(
    page.getByText("You're the only admin. Make someone else an admin first."),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/orgs/${organizationSlug}/members`);
});

test('a member removing someone else through the API is refused', async ({
  page,
  organizations,
  db,
}) => {
  const adminEmail = `sole-admin-${crypto.randomUUID()}@example.test`;
  const { slug: organizationSlug } = await organizations.create({
    name: `Member Api Refusal Foodservice ${crypto.randomUUID()}`,
    role: 'member',
    admin: { email: adminEmail },
  });
  const otherMember = await db
    .selectFrom('appUser')
    .innerJoin('auth.users', 'auth.users.id', 'appUser.id')
    .select('appUser.id as id')
    .where('auth.users.email', '=', adminEmail)
    .executeTakeFirstOrThrow();

  const response = await page.request.delete(
    organizationMemberApiHref(organizationSlug, otherMember.id),
  );

  expect(response.status()).toBe(403);
});
