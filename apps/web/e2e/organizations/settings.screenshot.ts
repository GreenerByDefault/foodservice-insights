/** Two committed images. `settings-admin.png` is the whole screen: the rename form and, below
 * it, the delete section. `delete-organization.png` is its confirm dialog, open with the phrase
 * field empty. A member never reaches this page (see `settings.e2e.ts`), so there is no
 * member-role image of either.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('admin: the rename form and the delete section below it', async ({ page, organizations }) => {
  const organizationId = await organizations.create({ name: 'Settings Screenshot Admin' });

  await page.goto(`/orgs/${organizationId}/settings`);
  await ensureHydrated(page);

  await expect(page.getByLabel('Organization name')).toHaveValue('Settings Screenshot Admin');
  await expectScreenshots(page, 'settings-admin.png');
});

test('admin: the delete confirm dialog, phrase field empty and confirm disabled', async ({
  page,
  organizations,
}) => {
  const organizationId = await organizations.create({ name: 'Settings Screenshot Delete' });

  await page.goto(`/orgs/${organizationId}/settings`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Delete organization' }).click();
  await expect(page.getByRole('button', { name: 'Yes, delete organization' })).toBeDisabled();

  await expectScreenshots(page, 'delete-organization.png');
});
