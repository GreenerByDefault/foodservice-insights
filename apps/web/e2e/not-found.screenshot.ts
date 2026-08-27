import { test } from '@playwright/test';
import { expectScreenshot } from './lib/screenshots';

test('the 404 page', async ({ page }) => {
  await page.goto('/no-such-page');
  await expectScreenshot(page, 'not-found.png');
});
