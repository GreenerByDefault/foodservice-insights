import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RenameForm from './rename-form.svelte';

const { invalidateAllMock } = vi.hoisted(() => ({ invalidateAllMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }));

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateAllMock.mockClear();
});

describe('RenameForm', () => {
  test('PATCHes the organization and refreshes on success', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(RenameForm, {
      organizationId: 'org-1',
      initialName: 'Acme Foodservice',
    });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => invalidateAllMock.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orgs/org-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Riverside Foods' });
  });

  test('an unreachable server shows the unknown-outcome message and does not refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(RenameForm, {
      organizationId: 'org-1',
      initialName: 'Acme Foodservice',
    });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByText(/not sure whether that rename went through/))
      .toBeInTheDocument();
    expect(invalidateAllMock).not.toHaveBeenCalled();
  });
});
