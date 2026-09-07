import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CreateOrganizationForm from './create-organization-form.svelte';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  gotoMock.mockClear();
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

    await expect.poll(() => gotoMock.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orgs');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Acme Foodservice' });
    expect(gotoMock).toHaveBeenCalledWith('/orgs/org-1');
  });

  test('an unreachable server shows the unknown-outcome message and a link to the organization list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(CreateOrganizationForm);

    await screen.getByLabelText('Organization name').fill('Acme Foodservice');
    await screen.getByRole('button', { name: 'Create organization' }).click();

    await expect
      .element(screen.getByText(/not sure whether that went through/))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole('link', { name: 'your organizations' }))
      .toHaveAttribute('href', '/orgs');
    expect(gotoMock).not.toHaveBeenCalled();
  });
});
