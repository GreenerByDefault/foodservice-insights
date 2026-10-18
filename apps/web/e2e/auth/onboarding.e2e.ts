import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { waitForSignInCode } from '../lib/emailed-code.ts';

test.describe('signed in with no name', () => {
  test.use({ identity: 'new' });

  test('is asked for one at the page they asked for, which renders once it is saved', async ({
    page,
  }) => {
    const response = await page.goto('/account');
    expect(response?.status()).toBe(403);
    await ensureHydrated(page);

    await page.getByLabel('Your name').fill('Alex Baker');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page).toHaveURL('/account');
    await expect(page.getByLabel('Your name')).toHaveValue('Alex Baker');
  });
});

test.describe('signed out', () => {
  test.use({ identity: 'anonymous' });

  test('signing in on a 401 page with no name asks for one there, then renders the page', async ({
    page,
    users,
  }) => {
    const person = await users.create({ onboarded: false });

    const response = await page.goto('/account');
    expect(response?.status()).toBe(401);
    await ensureHydrated(page);

    await page.getByLabel('Email address').fill(person.signInEmail);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('Sign-in code').fill(await waitForSignInCode(person.signInEmail));

    await expect(
      page.getByRole('heading', { name: 'Welcome to Foodservice Insights' }),
    ).toBeVisible();
    await expect(page.getByLabel('Your name')).toBeEmpty();
    await page.getByLabel('Your name').fill('Alex Baker');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page).toHaveURL('/account');
  });
});
