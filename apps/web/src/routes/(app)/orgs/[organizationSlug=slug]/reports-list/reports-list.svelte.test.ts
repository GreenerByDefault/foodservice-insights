import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReportListRow } from '../+page.server.ts';
import ReportsList from './reports-list.svelte';
import { aReport } from './testing/fixtures.ts';

describe('ReportsList', () => {
  test('renders one row per report, as a list', async () => {
    const screen = await render(ReportsList, {
      reports: [
        aReport({
          id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
          name: 'Q1 procurement',
        }),
        aReport({
          id: 'a4f8e2b0-1111-4a11-8111-000000000002' as ReportListRow['id'],
          name: 'Winter deliveries',
        }),
      ],
    });

    await expect.element(screen.getByRole('list')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: /Q1 procurement/ })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: /Winter deliveries/ })).toBeVisible();
  });

  test('shows an empty-state sentence when there are no reports', async () => {
    const screen = await render(ReportsList, { reports: [] });

    await expect.element(screen.getByText('No reports yet.')).toBeVisible();
  });
});
