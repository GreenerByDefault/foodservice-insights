import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import CreateOrganizationForm from './create-organization-form.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

describe('CreateOrganizationForm', () => {
  test('posts the name to /api/orgs and follows the location header', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ organizationId: 'org-1' }), {
        status: 201,
        headers: { location: '/orgs/org-1' },
      }),
    );
    const screen = await render(CreateOrganizationForm);

    await screen.getByLabelText('Organization name').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Create organization' }).click();

    await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Acme Foodservice' });
    expect(goto).toHaveBeenCalledWith('/orgs/org-1');
  });

  test('an unreachable server shows the unknown-outcome message and a link to the organization list', async () => {
    stubUnreachableFetch();
    const screen = await render(CreateOrganizationForm);

    await screen.getByLabelText('Organization name').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Create organization' }).click();

    await expect
      .element(screen.getByText(/not sure whether that went through/))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole('link', { name: 'your organizations' }))
      .toHaveAttribute('href', '/orgs');
    expect(goto).not.toHaveBeenCalled();
  });
});
