/** One committed image: the rename form an admin gets. A member never reaches this page (see
 * `settings.e2e.ts`), so there is no member-role image here. The delete section a follow-up PR
 * adds below the rename form will grow this image; it doesn't exist yet.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('admin: the rename form', async ({ page, organizations }) => {
  const organizationId = await organizations.create({ name: 'Settings Screenshot Admin' });

  await page.goto(`/orgs/${organizationId}/settings`);
  await ensureHydrated(page);

  await expect(page.getByLabel('Organization name')).toHaveValue('Settings Screenshot Admin');
  await expectScreenshots(page, 'settings-admin.png');
});
