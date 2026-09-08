import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { invalidateAll } from '$app/navigation';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import RenameForm from './rename-form.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

describe('RenameForm', () => {
  test('PATCHes the organization and refreshes on success', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(RenameForm, {
      organizationSlug: 'org-1',
      initialName: 'Acme Foodservice',
    });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Riverside Foods' });
  });

  test('an unreachable server shows the unknown-outcome message and does not refresh', async () => {
    stubUnreachableFetch();
    const screen = await render(RenameForm, {
      organizationSlug: 'org-1',
      initialName: 'Acme Foodservice',
    });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByText(/not sure whether that rename went through/))
      .toBeInTheDocument();
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
