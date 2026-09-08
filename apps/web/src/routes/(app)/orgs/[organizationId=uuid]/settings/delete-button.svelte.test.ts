import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import DeleteButton from './delete-button.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

describe('DeleteButton', () => {
  test('names the organization in the trigger dialog and keeps confirm disabled until the name is typed', async () => {
    const screen = await render(DeleteButton, {
      organizationId: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();

    await expect
      .element(screen.getByRole('heading', { name: 'Delete Acme Foodservice?' }))
      .toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Yes, delete organization' });
    await expect.element(confirmButton).toBeDisabled();

    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Foodservice');
    await expect.element(confirmButton).toBeEnabled();
  });

  test('a partially typed name keeps confirm disabled', async () => {
    const screen = await render(DeleteButton, {
      organizationId: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Food');

    await expect
      .element(screen.getByRole('button', { name: 'Yes, delete organization' }))
      .toBeDisabled();
  });

  test('confirming DELETEs the organization and navigates to /orgs', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(DeleteButton, {
      organizationId: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Yes, delete organization' }).click();

    await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1');
    expect(options.method).toBe('DELETE');
    expect(goto).toHaveBeenCalledWith('/orgs', { invalidateAll: true });
  });

  test('an unreachable server shows the inline error and does not navigate', async () => {
    stubUnreachableFetch();
    const screen = await render(DeleteButton, {
      organizationId: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Yes, delete organization' }).click();

    await expect
      .element(screen.getByText('Could not delete this organization. Please try again.'))
      .toBeInTheDocument();
    expect(goto).not.toHaveBeenCalled();
  });
});
