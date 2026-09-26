import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from './fixtures/test.ts';

// The whole chain in one assertion: a real session cookie, `getUser()` in `identifyUser`, the
// lookup in `hooks.server.ts`, the guard on `(app)`, and the data reaching a component. Goes
// straight to the org rather than through `/` — the fan-out that picks an organization is covered
// exhaustively and hermetically by the pure unit test `resolve-post-sign-in-destination.test.ts`.
test('a signed-in request reaches its organization, which the shell names', async ({
  page,
  user,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);

  await expect(page.getByRole('banner')).toContainText(org.name);

  // The account menu is portalled outside `<header>`, so the email is checked there instead.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText(user.email)).toBeVisible();
});

test.describe('signed out', () => {
  test.use({ identity: 'anonymous' });

  test('/ is the marketing page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('an organization answers 401', async ({ page }) => {
    // Any slug will do: the `(app)` gate refuses before anything looks the organization up.
    const response = await page.goto('/orgs/northgate-provisions');

    expect(response?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  });
});
