import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubPendingFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import SitePasswordForm from './site-password-form.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submit(onSignedIn: () => Promise<void> = vi.fn().mockResolvedValue(undefined)) {
  const screen = await render(SitePasswordForm, { onSignedIn });
  await screen.getByLabelText('Password').fill('correct horse battery');
  await screen.getByRole('button', { name: 'Sign in' }).click();
  return screen;
}

describe('SitePasswordForm', () => {
  test('posts the password, then hands off', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    // A real `onSignedIn` navigates; it never resolves back into the form.
    const onSignedIn = vi.fn(() => new Promise<void>(() => {}));

    const screen = await submit(onSignedIn);

    await expect.poll(() => onSignedIn.mock.calls.length).toBe(1);
    expectFetched(fetchMock, {
      url: '/api/site-session',
      method: 'POST',
      body: { password: 'correct horse battery' },
    });
    await expect.element(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });

  test('a wrong password says so, and hands the field back without signing in', async () => {
    stubFetch(jsonResponse({ message: 'Wrong password' }, 401));
    const onSignedIn = vi.fn();

    const screen = await submit(onSignedIn);

    await expect.element(screen.getByRole('alert')).toHaveTextContent("That password isn't right.");
    const field = screen.getByLabelText('Password');
    await expect.element(field).toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => document.activeElement).toBe(field.element());
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('a server that could not be reached leaves the form ready to retry', async () => {
    stubUnreachableFetch();
    const onSignedIn = vi.fn();

    const screen = await submit(onSignedIn);

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent("Couldn't sign in. Try again.");
    await expect.element(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('the button disables and swaps its label while the request is in flight', async () => {
    const { resolve } = stubPendingFetch();
    const screen = await submit();

    const button = screen.getByRole('button', { name: 'Signing in…' });
    await expect.element(button).toBeDisabled();
    await expect.element(button).toHaveAttribute('aria-busy', 'true');

    resolve(new Response(null, { status: 204 }));
  });

  test('a request that settles after the form is gone does not sign in', async () => {
    const { resolve } = stubPendingFetch();
    const onSignedIn = vi.fn();
    const screen = await submit(onSignedIn);

    screen.unmount();
    resolve(new Response(null, { status: 204 }));
    await new Promise((settle) => setTimeout(settle));

    expect(onSignedIn).not.toHaveBeenCalled();
  });

  describe('a sign-in that does not navigate', () => {
    test('says it could not sign in', async () => {
      stubFetch(new Response(null, { status: 204 }));

      const screen = await submit(vi.fn().mockResolvedValue(undefined));

      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent("Couldn't sign in. Try again.");
      await expect.element(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    });

    test('an onSignedIn that rejects is logged and fails the same way', async () => {
      stubFetch(new Response(null, { status: 204 }));
      const cause = new Error('Failed to fetch');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const screen = await submit(vi.fn().mockRejectedValue(cause));

      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent("Couldn't sign in. Try again.");
      expect(consoleError.mock.calls).toEqual([['Could not finish signing in', cause]]);
      consoleError.mockRestore();
    });
  });
});
