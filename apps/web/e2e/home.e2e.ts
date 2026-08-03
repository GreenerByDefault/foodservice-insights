import { expect, test } from '@playwright/test';

test('placeholder test: home page renders the product name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Foodservice Insights');
});
