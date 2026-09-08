import { expect } from '@playwright/test';
import { test } from './fixtures/test.ts';

// The whole chain in one assertion: the run's identity, the lookup in `hooks.server.ts`, the guard
// on `(app)`, and the data reaching a component. Goes straight to the org rather than through `/` —
// the fan-out that picks the one organization is covered exhaustively and hermetically by the pure
// unit test `resolve-post-sign-in-destination.test.ts`, and asserting on it here would break the
// moment another spec gave this user a second organization, which they all now do.
//
// This test exists only because `identifyUser` ($lib/server/auth/identify.ts) is a stand-in that
// answers every request as one seeded user — there is no login to drive from a browser yet. When
// Supabase Auth lands, replace this with a real sign-in flow test (OTP submission, session cookie,
// logout), and with one that reaches `/` signed out and sees the marketing page.
test('a signed-in request reaches its organization, which the shell names', async ({
  page,
  user,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}`);

  await expect(page.getByRole('banner')).toContainText(org.name);

  // The account menu is portalled outside `<header>`, so the email is checked there instead.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText(user.email)).toBeVisible();
});
