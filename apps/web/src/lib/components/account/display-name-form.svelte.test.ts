import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import {
  expectFetched,
  stubFetch,
  stubPendingFetch,
  stubUnreachableFetch,
} from '$lib/testing/fetch';
import { resetToastMocks, toast } from '$lib/testing/toast';
import DisplayNameForm from './display-name-form.svelte';

vi.mock('svelte-sonner', () => import('$lib/testing/toast'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetToastMocks();
});

function props(onSaved = vi.fn().mockResolvedValue(undefined)) {
  return { initialName: 'Sam Cook', submitLabel: 'Save', onSaved };
}

describe('DisplayNameForm', () => {
  test('is seeded with the current name', async () => {
    const screen = await render(DisplayNameForm, props());

    await expect.element(screen.getByLabelText('Your name')).toHaveValue('Sam Cook');
  });

  test('an unrelated re-render does not clobber an in-progress edit', async () => {
    const screen = await render(DisplayNameForm, props());
    const input = screen.getByLabelText('Your name');

    await input.fill('Unsaved Draft');
    await screen.rerender({ ...props(), initialName: 'Sam Cook' });

    await expect.element(input).toHaveValue('Unsaved Draft');
  });

  test('saves the trimmed name, then calls onSaved and toasts', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const screen = await render(DisplayNameForm, props(onSaved));

    await screen.getByLabelText('Your name').fill('  Alex Baker  ');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => onSaved.mock.calls.length).toBe(1);
    expectFetched(fetchMock, {
      url: '/api/account',
      method: 'PATCH',
      body: { displayName: 'Alex Baker' },
    });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Name updated to Alex Baker');
  });

  test('an unknown outcome shows an alert, and neither calls onSaved nor toasts', async () => {
    stubUnreachableFetch();
    const onSaved = vi.fn();
    const screen = await render(DisplayNameForm, props(onSaved));

    await screen.getByRole('button', { name: 'Save' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/not sure whether your name was saved/);
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('the button disables and swaps its label while the request is in flight', async () => {
    const { resolve } = stubPendingFetch();
    const screen = await render(DisplayNameForm, props());

    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    resolve(new Response(null, { status: 204 }));
  });

  test('an empty name is refused by the browser, without a request', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(DisplayNameForm, props());

    await screen.getByLabelText('Your name').fill('');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.element(screen.getByLabelText('Your name')).toBeInvalid();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
