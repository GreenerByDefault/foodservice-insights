import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CanceledView from './canceled-view.svelte';

const NOW = new Date('2026-01-15T10:10:00Z');
const STOPPED_AT = new Date('2026-01-15T10:07:00Z');
const NEW_REPORT_HREF = '/orgs/00000000-0000-0000-0000-000000000000/reports/new';
const DELETE_BUTTON_HREF = '/api/orgs/org-1/reports/report-1';
const ORGANIZATION_HREF = '/orgs/org-1';

describe('CanceledView', () => {
  test('says the report was stopped and links to start a new one', async () => {
    const screen = await render(CanceledView, {
      stoppedAt: STOPPED_AT,
      now: NOW,
      newReportHref: NEW_REPORT_HREF,
      deleteButtonHref: DELETE_BUTTON_HREF,
      organizationHref: ORGANIZATION_HREF,
    });

    await expect
      .element(screen.getByText('You stopped this report', { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByRole('link', { name: 'Upload a file' }))
      .toHaveAttribute('href', NEW_REPORT_HREF);
  });

  test('the stopped time carries an ISO datetime and a relative rendering', async () => {
    const screen = await render(CanceledView, {
      stoppedAt: STOPPED_AT,
      now: NOW,
      newReportHref: NEW_REPORT_HREF,
      deleteButtonHref: DELETE_BUTTON_HREF,
      organizationHref: ORGANIZATION_HREF,
    });

    const time = screen.container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(STOPPED_AT.toISOString());
    expect(time?.textContent).toBe('3 minutes ago');
  });
});
