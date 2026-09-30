import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { test as base } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

/** The page renders the signed-in address, so a screenshot needs a fixed one. Not the pinned
 * identity's: that user is shared, so which organizations it is the only admin of — which decides
 * what the delete section shows — depends on which specs ran first. Instead a fresh user, shown at
 * `email` by rewriting its mirror in the run database, which is the copy the app reads.
 *
 * `auth.users` holds each address once, so every test passes its own, and teardown puts the
 * original back so a retry can take it again. Copies of one test still collide, so
 * `--repeat-each` needs `--workers=1`. */
const test = base.extend<{ showEmailAs: (email: string) => Promise<void> }>({
  showEmailAs: async ({ db, user }, use) => {
    const setEmail = async (email: string) => {
      await db.updateTable('auth.users').set({ email }).where('id', '=', user.id).execute();
    };
    await use(setEmail);
    await setEmail(user.email);
  },
});

test('the account page', async ({ page, showEmailAs }) => {
  await showEmailAs('sam.cook+account@example.test');

  await page.goto('/account');
  await ensureHydrated(page);

  await expect(page.getByLabel('Your name')).not.toBeEmpty();
  await expect(page.getByRole('button', { name: 'Delete account' })).toBeEnabled();

  await expectScreenshots(page, 'account.png');
});

test('saving a name, failed', async ({ page, showEmailAs }) => {
  await showEmailAs('sam.cook+name@example.test');
  await page.route('**/api/account', (route) =>
    route.fulfill({ status: 500, json: { message: 'Internal Error' } }),
  );

  await page.goto('/account');
  await ensureHydrated(page);

  await page.getByLabel('Your name').fill('Alex Baker');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('not sure whether your name was saved');
  // Clicking Save blurs the input, whose focus ring fades out on a transition; captured mid-fade,
  // its rounded corner antialiases a shade differently from run to run.
  await page.waitForFunction(() => document.getAnimations().length === 0);

  await expectScreenshots(page, 'account-save-failed.png');
});

test('deleting the account, the only admin of organizations', async ({
  page,
  organizations,
  showEmailAs,
}) => {
  await showEmailAs('sam.cook+admin@example.test');
  await organizations.create({ name: 'Ridgeview Dining' });
  await organizations.create({ name: 'Lakeside Commissary' });

  await page.goto('/account');
  await ensureHydrated(page);

  await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();

  await expectScreenshots(page, 'account-sole-admin.png');
});

test('deleting the account, confirming', async ({ page, showEmailAs }) => {
  const email = 'sam.cook+delete@example.test';
  await showEmailAs(email);

  await page.goto('/account');
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByLabel(`Type "${email}" to confirm`).fill(email);
  await expect(page.getByRole('button', { name: 'Yes, delete my account' })).toBeEnabled();

  await expectScreenshots(page, 'account-delete-dialog.png');
});
