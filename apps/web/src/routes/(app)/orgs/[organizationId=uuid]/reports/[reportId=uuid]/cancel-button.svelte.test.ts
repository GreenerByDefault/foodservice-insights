import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CancelButton from './cancel-button.svelte';

const { invalidateAll } = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => ({ invalidateAll }));

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateAll.mockClear();
});

describe('CancelButton', () => {
  test('opens a confirming dialog, and "Keep it running" closes it without calling the endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const screen = await render(CancelButton, {
      cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
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
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  test('confirming calls the endpoint, closes the dialog, and refreshes the load', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(CancelButton, {
      cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .not.toBeInTheDocument();
    await expect.poll(() => invalidateAll.mock.calls.length).toBe(1);
  });

  test('a 409 — the attempt already finished — closes and refreshes rather than showing an error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report already finished' }), {
        status: 409,
      }),
    );
    const screen = await render(CancelButton, {
      cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Cancel this report?' }))
      .not.toBeInTheDocument();
    await expect.poll(() => invalidateAll.mock.calls.length).toBe(1);
  });

  test('an unreachable server keeps the dialog open and shows a retry message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(CancelButton, {
      cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
    });

    await screen.getByRole('button', { name: 'Cancel report' }).click();
    await screen.getByRole('button', { name: 'Yes, cancel report' }).click();

    await expect
      .element(screen.getByText('Could not cancel this report. Please try again.'))
      .toBeVisible();
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
