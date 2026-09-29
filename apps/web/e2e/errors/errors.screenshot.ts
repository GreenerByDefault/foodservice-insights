import { ensureHydrated } from '@gbd/browser-testing';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test.use({ identity: 'anonymous' });

test('the 404 page', async ({ page }) => {
  await page.goto('/no-such-page');
  await expectScreenshots(page, 'not-found.png');
});

// Any slug will do: the `(app)` gate refuses before anything looks the organization up.
test('the 401 page, which signs in on the spot', async ({ page }) => {
  await page.goto('/orgs/northgate-provisions');
  await ensureHydrated(page);
  await expectScreenshots(page, 'unauthorized.png');
});
