import { expect, test } from '@playwright/test';

test('an unknown URL renders the error page with the status the browser was given', async ({
  page,
}) => {
  const response = await page.goto('/no-such-page');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
});
