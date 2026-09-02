import { test } from '@playwright/test';
import { expectScreenshots } from './lib/screenshots';

test('the 404 page', async ({ page }) => {
  await page.goto('/no-such-page');
  await expectScreenshots(page, 'not-found.png');
});
