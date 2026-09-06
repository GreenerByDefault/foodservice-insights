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
  test('is seeded with the current name', async () => {
    const screen = await render(RenameForm, { organizationId: 'org-1', name: 'Acme Foodservice' });

    await expect
      .element(screen.getByLabelText('Organization name'))
      .toHaveValue('Acme Foodservice');
  });

  test('PATCHes the trimmed name and refreshes on success', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(RenameForm, { organizationId: 'org-1', name: 'Acme Foodservice' });

    await screen.getByLabelText('Organization name').fill('  Riverside Foods  ');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => invalidateAllMock.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orgs/org-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Riverside Foods' });
  });

  test('a 409 shows the inline error under the field, with focus moved there, and keeps the typed name', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Taken', code: 'name-taken' }), { status: 409 }),
    );
    const screen = await render(RenameForm, { organizationId: 'org-1', name: 'Acme Foodservice' });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByText('An organization with that name already exists.'))
      .toBeInTheDocument();
    await expect.element(screen.getByLabelText('Organization name')).toHaveValue('Riverside Foods');
    await expect.element(screen.getByLabelText('Organization name')).toHaveFocus();
    expect(invalidateAllMock).not.toHaveBeenCalled();
  });

  test('an unreachable server shows the unknown-outcome message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(RenameForm, { organizationId: 'org-1', name: 'Acme Foodservice' });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByText(/not sure whether that rename went through/))
      .toBeInTheDocument();
    expect(invalidateAllMock).not.toHaveBeenCalled();
  });

  test('the button disables while the request is in flight', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const screen = await render(RenameForm, { organizationId: 'org-1', name: 'Acme Foodservice' });

    await screen.getByLabelText('Organization name').fill('Riverside Foods');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolveFetch(new Response(null, { status: 204 }));
  });
});
