import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { waitForSignInCode } from '../lib/emailed-code.ts';

test.describe('signed in with no name', () => {
  test.use({ identity: 'new' });

  test('is asked for one before anything else, then sent on to create an organization', async ({
    page,
  }) => {
    await page.goto('/orgs');
    await expect(page).toHaveURL('/onboarding');
    await ensureHydrated(page);

    await page.getByLabel('Your name').fill('Alex Baker');
    await page.getByRole('button', { name: 'Continue' }).click();

    // They belong to no organization, so `/orgs` sends them on to make one.
    await expect(page).toHaveURL('/orgs/new');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('menu')).toContainText('Alex Baker');

    // Answered for good: the question is not asked again.
    await page.goto('/onboarding');
    await expect(page).toHaveURL('/orgs/new');
  });
});

test.describe('signed out', () => {
  test.use({ identity: 'anonymous' });

  // The 401 page re-runs the loads at the URL that was refused, so this is the `(app)` gate
  // redirecting a client-side invalidation rather than a fresh request.
  test('signing in on a 401 page with no name goes to onboarding, not the page refused', async ({
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

    await expect(page).toHaveURL('/onboarding');
    await expect(page.getByLabel('Your name')).toBeEmpty();
  });

  test('onboarding answers 401, with the sign-in form', async ({ page }) => {
    const response = await page.goto('/onboarding');

    expect(response?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  });
});
