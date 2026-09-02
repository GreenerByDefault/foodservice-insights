import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReportListRow } from './+page.server.ts';
import ReportRow from './report-row.svelte';

function aReport(overrides: Partial<ReportListRow> = {}): ReportListRow {
  return {
    id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
    href: '/orgs/org-1/reports/a4f8e2b0-1111-4a11-8111-000000000001',
    name: 'Q1 procurement',
    siteName: 'Riverside Cafeteria',
    creator: { displayName: 'Ana Ruiz', email: 'ana@example.test' },
    createdAt: new Date('2026-01-15T09:48:00Z'),
    status: 'succeeded',
    now: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

describe('ReportRow', () => {
  // The row renders two mutually-exclusive layouts (mobile and sm:+, see report-row.svelte)
  // toggled by CSS, so every field exists twice in the DOM regardless of viewport — `.first()`
  // picks the sm:+ copy, which is what's visible at this test's default (wide) viewport.

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
