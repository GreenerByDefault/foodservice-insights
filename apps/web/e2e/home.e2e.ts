import { expect, test } from '@playwright/test';

test('placeholder test: home page renders the product name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Foodservice Insights');
});

// The whole auth chain in one assertion: the seeded identity, the lookup in `hooks.server.ts`, the
// guard on `(app)`, and the data reaching a component.
test('a page under (app) renders the identity the request runs as', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('Phase One Foodservice');
  await expect(page.getByRole('banner')).toContainText('phase-one@example.test');
});
