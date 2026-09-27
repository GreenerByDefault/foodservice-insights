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
