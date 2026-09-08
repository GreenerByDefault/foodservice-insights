import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('the account menu, open', async ({ page, organizations }) => {
  const { slug: organizationSlug } = await organizations.create({
    name: 'Northgate Provisions',
  });

  await page.goto(`/orgs/${organizationSlug}`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Account' })).toBeVisible();

  // Hover it so the committed image also shows the hover affordance.
  await page.getByRole('menuitem', { name: 'Account' }).hover();

  await expectScreenshots(page, 'menu.png');
});
