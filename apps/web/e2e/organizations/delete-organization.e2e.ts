import { ensureHydrated } from '@gbd/browser-testing';
import { dbMsAgo } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('confirm stays disabled until the name is typed; confirming lands on /orgs, drops it from the switcher, and its reports are gone', async ({
  page,
  organizations,
}) => {
  // Deliberately not named with "Delete organization" in it — that's this screen's own button
  // text, and `getByRole` name matching is a substring match, so it would collide with the
  // switcher's accessible name once this organization is current.
  const name = `Org To Delete ${crypto.randomUUID()}`;
  const reportName = 'Q1 procurement';
  const organizationId = await organizations.create({
    name,
    reports: [{ name: reportName, createdAt: dbMsAgo(0), status: 'succeeded' }],
  });

  // Confirm the report is actually there before the organization goes, so "gone" afterward means
  // something.
  await page.goto(`/orgs/${organizationId}`);
  await ensureHydrated(page);
  await expect(page.getByRole('link', { name: new RegExp(reportName) })).toBeVisible();

  await page.goto(`/orgs/${organizationId}/settings`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Delete organization' }).click();
  const confirmButton = page.getByRole('button', { name: 'Yes, delete organization' });
  await expect(confirmButton).toBeDisabled();

  await page.getByLabel(`Type "${name}" to confirm`).fill(name.slice(0, -1));
  await expect(confirmButton).toBeDisabled();

  await page.getByLabel(`Type "${name}" to confirm`).fill(name);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // The success handler navigates to `/orgs`, but `_resolvePostSignInDestination` immediately
  // forwards that on to a single remaining organization when there is one — so the deterministic
  // assertion is just that the browser is no longer anywhere under the deleted organization.
  await page.waitForURL((url) => !url.pathname.includes(organizationId));

  if (new URL(page.url()).pathname === '/orgs') {
    // Landed on the bare list rather than being forwarded further — the deleted organization
    // must not be one of the rows.
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  } else {
    // Forwarded into another organization — its switcher must no longer offer the deleted one.
    await expect(page.getByRole('button', { name: 'Switch organization' })).not.toContainText(name);
  }

  // The organization, and everything that hung off it, is gone.
  const response = await page.goto(`/orgs/${organizationId}`);
  expect(response?.status()).toBe(404);
});
