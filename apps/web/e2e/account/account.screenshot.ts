import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

// The page renders the signed-in address, so it has to be the same one on every run.
test.use({ identity: 'pinned' });

test('the account page', async ({ page }) => {
  await page.goto('/account');
  await ensureHydrated(page);

  await expect(page.getByLabel('Your name')).not.toBeEmpty();

  await expectScreenshots(page, 'account.png');
});

test('saving a name, failed', async ({ page }) => {
  await page.route('**/api/account', (route) =>
    route.fulfill({ status: 500, json: { message: 'Internal Error' } }),
  );

  await page.goto('/account');
  await ensureHydrated(page);

  await page.getByLabel('Your name').fill('Alex Baker');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('not sure whether your name was saved');

  await expectScreenshots(page, 'account-save-failed.png');
});

test('saving a name, succeeded', async ({ page }) => {
  // Stubbed rather than saved: the pinned identity's name shows in every page's shell, so a real
  // save would change every other screenshot of it.
  await page.route('**/api/account', (route) => route.fulfill({ status: 204 }));
  // Stops the toast's auto-dismiss from firing mid-capture.
  await page.clock.install();

  await page.goto('/account');
  await ensureHydrated(page);

  await page.getByLabel('Your name').fill('Alex Baker');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-sonner-toast][data-mounted="true"]')).toContainText(
    'Name updated to Alex Baker',
  );

  await expectScreenshots(page, 'account-saved.png');
});
