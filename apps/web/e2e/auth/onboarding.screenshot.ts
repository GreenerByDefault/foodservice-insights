import { ensureHydrated } from '@gbd/browser-testing';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test.use({ identity: 'new' });

test('onboarding', async ({ page }) => {
  await page.goto('/account');
  await ensureHydrated(page);

  await expectScreenshots(page, 'onboarding.png');
});
