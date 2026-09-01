import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReportStatus from './report-status.svelte';

describe('ReportStatus', () => {
  test('pending reads as Queued', async () => {
    const screen = await render(ReportStatus, { status: 'pending' });
    await expect.element(screen.getByText('Queued')).toBeVisible();
  });

  test('processing reads as Processing', async () => {
    const screen = await render(ReportStatus, { status: 'processing' });
    await expect.element(screen.getByText('Processing')).toBeVisible();
  });

  test('succeeded reads as Ready', async () => {
    const screen = await render(ReportStatus, { status: 'succeeded' });
    await expect.element(screen.getByText('Ready')).toBeVisible();
  });

  test('failed reads as "Couldn\'t finish", in the destructive colour', async () => {
    const screen = await render(ReportStatus, { status: 'failed' });
    const status = screen.getByText("Couldn't finish");
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveClass('text-destructive');
  });

  test('canceled reads as Stopped', async () => {
    const screen = await render(ReportStatus, { status: 'canceled' });
    await expect.element(screen.getByText('Stopped')).toBeVisible();
  });
});
