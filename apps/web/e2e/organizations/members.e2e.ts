import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
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

test('the sole admin cannot demote their own row, and sees why', async ({
  page,
  organizations,
  user,
}) => {
  const { slug: organizationSlug } = await organizations.create({
    name: `Sole Admin Foodservice ${crypto.randomUUID()}`,
  });

  await page.goto(`/orgs/${organizationSlug}/members`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: `Manage ${user.email}` }).click();

  await expect(page.getByRole('menuitem', { name: 'Make member' })).toBeDisabled();
  await expect(page.getByText("You're the only admin")).toBeVisible();
});
