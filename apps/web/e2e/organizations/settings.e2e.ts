import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('member: settings is neither linked from the nav nor reachable directly', async ({
  page,
  organizations,
}) => {
  const organizationId = await organizations.create({
    name: `Settings 403 ${crypto.randomUUID()}`,
    role: 'member',
  });

  const response = await page.goto(`/orgs/${organizationId}/settings`);

  expect(response?.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("You don't have access");

  // The org shell's own error boundary caught this, not the site-wide one — the nav here is
  // what a bare root `+error.svelte` would not render.
  const nav = page.getByRole('navigation', { name: 'Organization' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});
