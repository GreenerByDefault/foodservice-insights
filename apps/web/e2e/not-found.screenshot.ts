import { test } from '@playwright/test';
import { expectScreenshot } from './lib/screenshots';

// The 404 page renders no database content and no timestamps, so while it is the only shot
// committed, a difference here is the container plumbing rather than a fixture that drifted.
test('the not-found page', async ({ page }) => {
  await page.goto('/no-such-page');

  await expectScreenshot(page, 'not-found.png');
});
