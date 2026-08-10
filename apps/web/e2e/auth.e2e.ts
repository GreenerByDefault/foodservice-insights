import { expect, test } from '@playwright/test';

// The whole chain in one assertion: the seeded identity, the lookup in `hooks.server.ts`, the guard
// on `(app)`, the login-flow fan-out in `orgs/+page.server.ts` picking the one organization, and the
// data reaching a component.
//
// This test exists only because `identifyUser` ($lib/server/auth/identify.ts) is a stand-in that
// always returns the seeded placeholder user — there is no login to drive from a browser yet. When
// Supabase Auth lands, replace this with a real sign-in flow test (OTP submission, session cookie,
// logout), and with one that reaches `/` signed out and sees the marketing page.
test('a signed-in request lands on its one organization, which the shell names', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('banner')).toContainText('Phase One Foodservice');
  await expect(page.getByRole('banner')).toContainText('phase-one@example.test');
});
