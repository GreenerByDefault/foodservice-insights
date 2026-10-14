/** The site password, `placeholder` mode's sign-in. Here rather than in `apps/web/e2e`, which runs
 * `supabase`, because this is the one tier that runs `placeholder` — the way production is hosted
 * until it has email. Every other spec here already signs in through `/api/site-session`; this one
 * is the form, the cookie the production image sets, and signing out. */

import { ensureHydrated } from '@gbd/browser-testing';
import { test } from '@gbd/browser-testing/fixtures';
import { requireEnv } from '@gbd/core/env';
import { expect } from '@playwright/test';

test.use({ identity: 'anonymous' });

test('the site password signs a visitor in where they were, and signing out ends it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');

  const refused = await page.goto('/orgs');
  expect(refused?.status()).toBe(401);
  await ensureHydrated(page);

  const password = page.getByLabel('Password');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await password.fill('not-the-site-password');
  await signIn.click();
  await expect(page.getByRole('alert')).toHaveText("That password isn't right.");

  await password.fill(requireEnv('SITE_PASSWORD'));
  await signIn.click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/');

  // The cookie is gone, not just the page's view of it: a fresh request is refused.
  const afterSignOut = await page.goto('/orgs');
  expect(afterSignOut?.status()).toBe(401);
});
