import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { stubFetch, stubPendingFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import CancelButton from './cancel-button.svelte';

const ORGANIZATION_ID = 'org-1';
const REPORT_ID = 'report-1';

/** Stands in for the polling view's `poll`, which is what the button asks for a refresh. */
const onReportChanged = vi.fn(() => Promise.resolve());

afterEach(() => {
  vi.unstubAllGlobals();
  onReportChanged.mockClear();
});

describe('CancelButton', () => {
  test('opens a confirming dialog, and "Keep it running" closes it without calling the endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const screen = await render(CancelButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .toBeVisible();

    await screen.getByRole('button', { name: 'Keep it running' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReportChanged).not.toHaveBeenCalled();
  });

  test('confirming calls the endpoint, closes the dialog, and refreshes just this report', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(CancelButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .not.toBeInTheDocument();
    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
  });

  test('a 409 — the attempt already finished — closes and refreshes rather than showing an error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report already finished' }), {
        status: 409,
      }),
    );
    const screen = await render(CancelButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .not.toBeInTheDocument();
    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
  });

  test('while the request is in flight, the confirm button is disabled', async () => {
    const { resolve } = stubPendingFetch();
    const screen = await render(CancelButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect.element(screen.getByRole('button', { name: 'Yes, cancel report' })).toBeDisabled();

    resolve(new Response(null, { status: 204 }));
    await expect.poll(() => onReportChanged.mock.calls.length).toBe(1);
  });

  test('an unreachable server keeps the dialog open and shows a retry message', async () => {
    stubUnreachableFetch();
    const screen = await render(CancelButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
      onReportChanged,
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByText('Could not cancel this report. Please try again.'))
      .toBeVisible();
    expect(onReportChanged).not.toHaveBeenCalled();
  });
});
