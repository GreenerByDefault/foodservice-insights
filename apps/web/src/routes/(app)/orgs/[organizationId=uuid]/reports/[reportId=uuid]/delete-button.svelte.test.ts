import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import DeleteButton from './delete-button.svelte';

const ORGANIZATION_ID = 'org-1';
const REPORT_ID = 'report-1';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  gotoMock.mockClear();
});

describe('DeleteButton', () => {
  test('opens a confirming dialog, and "Keep it" closes it without calling the endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const screen = await render(DeleteButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await expect
      .element(screen.getByRole('heading', { name: 'Delete this report?' }))
      .toBeVisible();

    await screen.getByRole('button', { name: 'Keep it' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Delete this report?' }))
      .not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gotoMock).not.toHaveBeenCalled();
  });

  test('confirming calls the endpoint and navigates to the organization', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(DeleteButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect.poll(() => gotoMock.mock.calls.length).toBe(1);
    expect(gotoMock).toHaveBeenCalledWith(`/orgs/${ORGANIZATION_ID}`);
  });

  test('while the request is in flight, the confirm button is disabled', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const screen = await render(DeleteButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect.element(screen.getByRole('button', { name: 'Yes, delete report' })).toBeDisabled();

    resolveFetch(new Response(null, { status: 204 }));
    await expect.poll(() => gotoMock.mock.calls.length).toBe(1);
  });

  test('an unreachable server keeps the dialog open and shows a retry message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(DeleteButton, {
      organizationId: ORGANIZATION_ID,
      reportId: REPORT_ID,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect
      .element(screen.getByText('Could not delete this report. Please try again.'))
      .toBeVisible();
    expect(gotoMock).not.toHaveBeenCalled();
  });
});
