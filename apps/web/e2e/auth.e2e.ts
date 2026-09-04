import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { expect, test } from '@playwright/test';

// The whole chain in one assertion: the seeded identity, the lookup in `hooks.server.ts`, the guard
// on `(app)`, and the data reaching a component. Goes straight to the org rather than through `/` —
// the fan-out that picks the one organization is covered exhaustively and hermetically by the pure
// unit test `resolve-post-sign-in-destination.test.ts`, and asserting on it here would mean the
// placeholder user can never be given a second organization without breaking this spec.
//
// This test exists only because `identifyUser` ($lib/server/auth/identify.ts) is a stand-in that
// always returns the seeded placeholder user — there is no login to drive from a browser yet. When
// Supabase Auth lands, replace this with a real sign-in flow test (OTP submission, session cookie,
// logout), and with one that reaches `/` signed out and sees the marketing page.
test('a signed-in request reaches its organization, which the shell names', async ({ page }) => {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`);

  await expect(page.getByRole('banner')).toContainText('Phase One Foodservice');

  // The account menu is portalled outside `<header>`, so the email is checked there instead.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText('phase-one@example.test')).toBeVisible();
});
