import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReportHeading from './report-heading.svelte';

describe('ReportHeading', () => {
  test('shows the report name, site name, and creator', async () => {
    const screen = await render(ReportHeading, {
      name: 'Q1 procurement',
      siteName: 'Riverside Diner',
      creator: { displayName: 'Dana Cook', email: 'dana@example.test' },
    });

    await expect.element(screen.getByRole('heading', { name: 'Q1 procurement' })).toBeVisible();
    await expect.element(screen.getByText('Riverside Diner · Created by Dana Cook')).toBeVisible();
  });

  test('omits the site name when there is none', async () => {
    const screen = await render(ReportHeading, {
      name: 'Q1 procurement',
      siteName: null,
      creator: { displayName: 'Dana Cook', email: 'dana@example.test' },
    });

    await expect.element(screen.getByText('Created by Dana Cook')).toBeVisible();
  });

  test('falls back to email when the creator has no display name', async () => {
    const screen = await render(ReportHeading, {
      name: 'Q1 procurement',
      siteName: null,
      creator: { displayName: null, email: 'dana@example.test' },
    });

    await expect.element(screen.getByText('Created by dana@example.test')).toBeVisible();
  });

  test('says a deleted user submitted it when the creator is null', async () => {
    const screen = await render(ReportHeading, {
      name: 'Q1 procurement',
      siteName: null,
      creator: null,
    });

    await expect.element(screen.getByText('Created by a deleted user')).toBeVisible();
  });
});
