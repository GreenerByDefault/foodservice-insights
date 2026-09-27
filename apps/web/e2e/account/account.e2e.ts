import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('renaming yourself on /account changes the name the account menu shows', async ({ page }) => {
  await page.goto('/account');
  await ensureHydrated(page);

  // Every minted user starts with the same name, so the new one is what proves the rename.
  await page.getByLabel('Your name').fill('Alex Baker');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toContainText('Alex Baker');

  // And it was stored, not just rendered.
  await page.reload();
  await expect(page.getByLabel('Your name')).toHaveValue('Alex Baker');
});
