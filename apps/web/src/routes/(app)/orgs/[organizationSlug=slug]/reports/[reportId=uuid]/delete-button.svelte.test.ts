import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import { stubFetch, stubPendingFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import { resetToastMocks, toast } from '$lib/testing/toast';
import DeleteButton from './delete-button.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));
vi.mock('svelte-sonner', () => import('$lib/testing/toast'));

const ORGANIZATION_SLUG = 'org-1';
const REPORT_ID = 'report-1';
const REPORT_NAME = 'Q1 procurement';

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
  resetToastMocks();
});

describe('DeleteButton', () => {
  test('opens a confirming dialog, and "Keep it" closes it without calling the endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const screen = await render(DeleteButton, {
      organizationSlug: ORGANIZATION_SLUG,
      reportId: REPORT_ID,
      reportName: REPORT_NAME,
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
    expect(goto).not.toHaveBeenCalled();
  });

  test('confirming calls the endpoint, navigates to the organization and toasts', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(DeleteButton, {
      organizationSlug: ORGANIZATION_SLUG,
      reportId: REPORT_ID,
      reportName: REPORT_NAME,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
    expect(goto).toHaveBeenCalledWith(`/orgs/${ORGANIZATION_SLUG}`);
    await expect.poll(() => toast.success.mock.calls).toEqual([['Deleted Q1 procurement']]);
  });

  test('while the request is in flight, the confirm button is disabled', async () => {
    const { resolve } = stubPendingFetch();
    const screen = await render(DeleteButton, {
      organizationSlug: ORGANIZATION_SLUG,
      reportId: REPORT_ID,
      reportName: REPORT_NAME,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect.element(screen.getByRole('button', { name: 'Yes, delete report' })).toBeDisabled();

    resolve(new Response(null, { status: 204 }));
    await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
  });

  test('an unreachable server keeps the dialog open and shows a retry message', async () => {
    stubUnreachableFetch();
    const screen = await render(DeleteButton, {
      organizationSlug: ORGANIZATION_SLUG,
      reportId: REPORT_ID,
      reportName: REPORT_NAME,
    });

    await screen.getByRole('button', { name: 'Delete report' }).click();
    await screen.getByRole('button', { name: 'Yes, delete report' }).click();

    await expect
      .element(screen.getByText('Could not delete this report. Please try again.'))
      .toBeVisible();
    expect(goto).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
