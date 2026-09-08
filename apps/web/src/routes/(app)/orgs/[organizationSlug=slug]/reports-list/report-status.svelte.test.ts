import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReportStatus from './report-status.svelte';

describe('ReportStatus', () => {
  test('pending reads as Queued, in the muted colour, with no spinner', async () => {
    const screen = await render(ReportStatus, { status: 'pending' });
    const status = screen.getByText('Queued');
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveClass('text-muted-foreground');
    expect(status.element().querySelector('svg')).toBeNull();
  });

  test('processing reads as Processing, with a spinner', async () => {
    const screen = await render(ReportStatus, { status: 'processing' });
    const status = screen.getByText('Processing');
    await expect.element(status).toBeVisible();
    expect(status.element().querySelector('svg')).not.toBeNull();
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
