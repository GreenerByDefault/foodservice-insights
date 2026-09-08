import { ensureHydrated } from '@gbd/browser-testing';
import type { Database, OrganizationId } from '@gbd/db';
import { expect } from '@playwright/test';
import type { Kysely } from 'kysely';
import { test } from '../fixtures/test.ts';

/** The organization slugged in the URL — the success page has no id on screen, only the slug —
 * so the row itself is the only way back to an id to adopt. */
async function organizationIdFromUrl(db: Kysely<Database>, url: string): Promise<OrganizationId> {
  const match = /\/orgs\/([a-z0-9-]+)$/.exec(url);
  if (!match) throw new Error(`expected an organization URL, got ${url}`);
  const row = await db
    .selectFrom('organization')
    .select('id')
    .where('slug', '=', match[1] as string)
    .executeTakeFirstOrThrow();
  return row.id;
}

test('filling in a name creates the organization and lands on it, named in the shell', async ({
  page,
  organizations,
  db,
}) => {
  const name = `Acme Foodservice ${crypto.randomUUID()}`;

  await page.goto('/orgs/new');
  await ensureHydrated(page);
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page).toHaveURL(/\/orgs\/[a-z0-9-]+$/);
  await expect(page.getByRole('button', { name: 'Switch organization' })).toContainText(name);

  // Playwright runs every e2e spec against one shared run database (fullyParallel), so this
  // organization must not outlive the test — adopted, since the form created it rather than
  // the `organizations` fixture.
  organizations.adopt(await organizationIdFromUrl(db, page.url()));
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
