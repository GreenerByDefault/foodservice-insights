import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '#lib/testing/fetch.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import { goto } from '$app/navigation';
import DeleteButton from './delete-button.svelte';

vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
  resetToastMocks();
});

describe('DeleteButton', () => {
  test('names the organization in the trigger dialog and keeps confirm disabled until the name is typed', async () => {
    const screen = await render(DeleteButton, {
      organizationSlug: 'org-1',
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

  test('canceling and reopening clears the typed name, so confirm is disabled again', async () => {
    const screen = await render(DeleteButton, {
      organizationSlug: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Keep it' }).click();

    await screen.getByRole('button', { name: 'Delete organization' }).click();

    await expect
      .element(screen.getByLabelText('Type "Acme Foodservice" to confirm'))
      .toHaveValue('');
    await expect
      .element(screen.getByRole('button', { name: 'Yes, delete organization' }))
      .toBeDisabled();
  });

  test('a partially typed name keeps confirm disabled', async () => {
    const screen = await render(DeleteButton, {
      organizationSlug: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Food');

    await expect
      .element(screen.getByRole('button', { name: 'Yes, delete organization' }))
      .toBeDisabled();
  });

  test('confirming DELETEs the organization, navigates to /orgs and toasts', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(DeleteButton, {
      organizationSlug: 'org-1',
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
    await expect.poll(() => toast.success.mock.calls).toEqual([['Deleted Acme Foodservice']]);
  });

  test('an unreachable server shows the inline error, and neither navigates nor toasts', async () => {
    stubUnreachableFetch();
    const screen = await render(DeleteButton, {
      organizationSlug: 'org-1',
      organizationName: 'Acme Foodservice',
    });

    await screen.getByRole('button', { name: 'Delete organization' }).click();
    await screen.getByLabelText('Type "Acme Foodservice" to confirm').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Yes, delete organization' }).click();

    await expect
      .element(screen.getByText('Could not delete this organization. Please try again.'))
      .toBeInTheDocument();
    expect(goto).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
