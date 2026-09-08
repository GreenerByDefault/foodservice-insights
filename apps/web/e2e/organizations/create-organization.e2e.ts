import { ensureHydrated } from '@gbd/browser-testing';
import type { OrganizationId } from '@gbd/db';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

/** Extracts the id this test's own submission created, from the URL it lands on. */
function organizationIdFromUrl(url: string): OrganizationId {
  const match = /\/orgs\/([0-9a-f-]+)$/.exec(url);
  if (!match) throw new Error(`expected an organization URL, got ${url}`);
  return match[1] as OrganizationId;
}

test('filling in a name creates the organization and lands on it, named in the shell', async ({
  page,
  organizations,
}) => {
  const name = `Acme Foodservice ${crypto.randomUUID()}`;

  await page.goto('/orgs/new');
  await ensureHydrated(page);
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+$/);
  await expect(page.getByRole('button', { name: 'Switch organization' })).toContainText(name);

  // Playwright runs every e2e spec against one shared run database (fullyParallel), so this
  // organization must not outlive the test — adopted, since the form created it rather than
  // the `organizations` fixture.
  organizations.adopt(organizationIdFromUrl(page.url()));
});

test('a name already taken shows the inline error, and keeps the typed name', async ({
  page,
  organizations,
}) => {
  const name = `Acme Foodservice ${crypto.randomUUID()}`;
  await organizations.create({ name, role: 'member' });

  await page.goto('/orgs/new');
  await ensureHydrated(page);
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByText('An organization with that name already exists.')).toBeVisible();
  await expect(page.getByLabel('Organization name')).toHaveValue(name);
  await expect(page).toHaveURL('/orgs/new');
});
