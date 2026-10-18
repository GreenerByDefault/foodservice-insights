import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

// The page renders the signed-in address, so it has to be the same one on every run.
test.use({ identity: 'pinned' });

test('the new organization form, before anything is typed', async ({ page }) => {
  await page.goto('/orgs/new');
  await ensureHydrated(page);

  await expect(page.getByLabel('Organization name')).toBeVisible();
  await expectScreenshots(page, 'new.png');
});
