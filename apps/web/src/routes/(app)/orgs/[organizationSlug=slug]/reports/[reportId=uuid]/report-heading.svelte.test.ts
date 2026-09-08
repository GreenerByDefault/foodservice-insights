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

  // Site name, creator name, and their fallbacks are subheading()'s branches — see
  // subheading.test.ts. This only has to show the heading passes its props through.
});
