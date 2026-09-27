import { test } from './fixtures/test.ts';
import { expectScreenshots } from './lib/screenshots.ts';

test.use({ identity: 'anonymous' });

test('the marketing page', async ({ page }) => {
  await page.goto('/');
  await expectScreenshots(page, 'marketing.png');
});
