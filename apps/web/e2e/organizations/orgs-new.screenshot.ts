import { ensureHydrated } from '@gbd/browser-testing';
import { expect, test } from '@playwright/test';
import { expectScreenshots } from '../lib/screenshots.ts';

test('the new organization form, before anything is typed', async ({ page }) => {
  await page.goto('/orgs/new');
  await ensureHydrated(page);

  await expect(page.getByLabel('Organization name')).toBeVisible();
  await expectScreenshots(page, 'orgs-new.png');
});
