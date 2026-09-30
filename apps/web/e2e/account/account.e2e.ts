import { ensureHydrated } from '@gbd/browser-testing';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { waitForEmail } from '@gbd/email/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('renaming yourself on /account changes the name the account menu shows', async ({ page }) => {
  await page.goto('/account');
  await ensureHydrated(page);

  // Every minted user starts with the same name, so the new one is what proves the rename.
  await page.getByLabel('Your name').fill('Alex Baker');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toContainText('Alex Baker');

  // And it was stored, not just rendered.
  await page.reload();
  await expect(page.getByLabel('Your name')).toHaveValue('Alex Baker');
});

test.describe('deleting your account', () => {
  test("the only admin of an organization is refused, and the server won't either", async ({
    page,
    organizations,
  }) => {
    const name = `Only Admin Org ${crypto.randomUUID()}`;
    const { slug } = await organizations.create({ name });

    await page.goto('/account');
    await ensureHydrated(page);

    await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();
    await expect(page.getByRole('link', { name })).toHaveAttribute('href', `/orgs/${slug}/members`);

    // The disabled button is only the UI's word for it; the trigger is what holds the line.
    const response = await page.request.delete('/api/account');
    expect(response.status()).toBe(409);
    await page.reload();
    await expect(page.getByLabel('Your name')).toBeVisible();
  });

  test('an admin alongside another admin can delete, is signed out, and GBD is told', async ({
    page,
    organizations,
    user,
  }) => {
    const { slug } = await organizations.create({
      name: `Shared Admin Org ${crypto.randomUUID()}`,
      members: [{ role: 'admin' }],
    });

    await page.goto('/account');
    await ensureHydrated(page);

    await page.getByRole('button', { name: 'Delete account' }).click();
    await page.getByLabel(`Type "${user.email}" to confirm`).fill(user.email);
    await page.getByRole('button', { name: 'Yes, delete my account' }).click();

    await page.waitForURL('/');
    const response = await page.goto(`/orgs/${slug}`);
    expect(response?.status()).toBe(401);

    loadLocalEnv();
    const notice = await waitForEmail(requireEnv('EMAIL_GBD_ADDRESS'), { subject: user.email });
    expect(notice.subject).toContain(user.email);
  });
});
