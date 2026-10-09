import { ensureHydrated } from '@gbd/browser-testing';
import { GOTRUE_TEST_DOMAIN, readGoTrueEmail } from '@gbd/browser-testing/fixtures';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { waitForEmail } from '@gbd/email/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { waitForEmailChangeCode } from '../lib/emailed-code.ts';

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

// Only as far as GoTrue: it writes the change to the stack's main database, and the app under test
// reads the run's clone, so here `/account` and the menu keep the old address. The component test
// covers the refresh that shows the new one.
test('changing your email confirms the new address with a code', async ({ page, user }) => {
  // At GoTrue's test domain, which keeps the user inside the stale-user sweep's reach.
  const newEmail = `${crypto.randomUUID()}@${GOTRUE_TEST_DOMAIN}`;

  await page.goto('/account');
  await ensureHydrated(page);

  await page.getByLabel('Email').fill(newEmail);
  await page.getByRole('button', { name: 'Change email' }).click();
  await page.getByLabel('Confirmation code').fill(await waitForEmailChangeCode(newEmail));

  await expect(page.getByText(`Changed your email to ${newEmail}`)).toBeVisible();
  expect(await readGoTrueEmail(user.id)).toBe(newEmail);
});

test.describe('deleting your account', () => {
  test("the only admin of an organization is refused, and the server won't either", async ({
    page,
    organizations,
    baseURL,
  }) => {
    const name = `Only Admin Org ${crypto.randomUUID()}`;
    const { slug } = await organizations.create({ name });

    await page.goto('/account');
    await ensureHydrated(page);

    await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();
    await expect(page.getByRole('link', { name })).toHaveAttribute('href', `/orgs/${slug}/members`);

    // The disabled button is only the UI's word for it; the trigger is what holds the line. With an
    // origin, as a browser's own fetch would send, or SvelteKit 3 refuses a bodyless DELETE as CSRF.
    const response = await page.request.delete('/api/account', {
      headers: { origin: baseURL as string },
    });
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
    await expect(page.getByText('Deleted your account')).toBeVisible();
    const response = await page.goto(`/orgs/${slug}`);
    expect(response?.status()).toBe(401);

    loadLocalEnv();
    const notice = await waitForEmail(requireEnv('EMAIL_GBD_ADDRESS'), { subject: user.email });
    expect(notice.subject).toContain(user.email);
  });
});
