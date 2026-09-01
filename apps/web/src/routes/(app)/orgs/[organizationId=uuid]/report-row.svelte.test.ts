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
  test('links to the report, and shows its name and the joined metadata line', async () => {
    const report = aReport();

    const screen = await render(ReportRow, { report });

    const link = screen.getByRole('link');
    await expect.element(link).toHaveAttribute('href', report.href);
    await expect.element(screen.getByText('Q1 procurement')).toBeVisible();
    await expect
      .element(screen.getByText('Riverside Cafeteria · Created by Ana Ruiz · 12 minutes ago'))
      .toBeVisible();
  });

  test('omits the site name when there is none', async () => {
    const report = aReport({ siteName: null });

    const screen = await render(ReportRow, { report });

    await expect.element(screen.getByText('Created by Ana Ruiz · 12 minutes ago')).toBeVisible();
  });

  test('falls back to email when the creator has no display name', async () => {
    const report = aReport({ creator: { displayName: null, email: 'ana@example.test' } });

    const screen = await render(ReportRow, { report });

    await expect.element(screen.getByText(/Created by ana@example\.test/)).toBeVisible();
  });

  test('says a deleted user submitted it when the creator is null', async () => {
    const report = aReport({ creator: null });

    const screen = await render(ReportRow, { report });

    await expect.element(screen.getByText(/Created by a deleted user/)).toBeVisible();
  });

  test('shows the row status', async () => {
    const report = aReport({ status: 'failed' });

    const screen = await render(ReportRow, { report });

    await expect.element(screen.getByText("Couldn't finish")).toBeVisible();
  });
});
