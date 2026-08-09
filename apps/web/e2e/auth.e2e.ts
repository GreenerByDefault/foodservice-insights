import { expect, test } from '@playwright/test';

// The whole auth chain in one assertion: the seeded identity, the lookup in `hooks.server.ts`, the
// guard on `(app)`, and the data reaching a component.
//
// This test exists only because `identifyUser` (`$lib/server/auth/identify.ts`) is a stand-in that
// always returns the seeded placeholder user — there is no login to drive from a browser yet. When
// Supabase Auth lands, replace this with a real sign-in flow test (OTP submission, session cookie,
// logout).
test('a page under (app) renders the identity the request runs as', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('Phase One Foodservice');
  await expect(page.getByRole('banner')).toContainText('phase-one@example.test');
});
