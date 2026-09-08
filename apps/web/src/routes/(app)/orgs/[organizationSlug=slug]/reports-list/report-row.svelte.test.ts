import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReportRow from './report-row.svelte';
import { aReport } from './testing/fixtures.ts';

describe('ReportRow', () => {
  // The same elements are repeated in the DOM for mobile vs desktop, so we use `.first()`.

  test('links to the report, and shows its name and metadata', async () => {
    const report = aReport();

    const screen = await render(ReportRow, { report });

    const link = screen.getByRole('link');
    await expect.element(link).toHaveAttribute('href', report.href);
    await expect.element(screen.getByText('Q1 procurement').first()).toBeVisible();
    await expect
      .element(screen.getByText('Riverside Cafeteria · Created by Ana Ruiz').first())
      .toBeVisible();
    await expect.element(screen.getByText('12 minutes ago').first()).toBeVisible();
  });

  // Site name, creator name, and their fallbacks are subheading()'s branches — see
  // subheading.test.ts. This only has to show the row passes report's fields through.

  test('shows the row status', async () => {
    const report = aReport({ status: 'failed' });

    const screen = await render(ReportRow, { report });

    await expect.element(screen.getByText("Couldn't finish").first()).toBeVisible();
  });
});
