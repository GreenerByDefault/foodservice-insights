import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { AuthMode } from '#lib/auth/mode.js';
import { fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import { expectFetched, stubFetch } from '#lib/testing/fetch.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { refreshAll } from '$app/navigation';
import ErrorPage from './error-page.svelte';

const state = vi.hoisted(() => ({
  auth: null as ReturnType<typeof fakeBrowserAuth> | null,
  mode: 'supabase' as AuthMode,
}));
vi.mock('#lib/auth/browser.js', () => ({ browserAuth: () => state.auth }));
vi.mock('#lib/auth/mode.js', () => ({ authMode: () => state.mode }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));

beforeEach(() => {
  state.auth = fakeBrowserAuth();
  state.mode = 'supabase';
  resetNavigationMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ErrorPage', () => {
  it('leads with copy for the status rather than the status code', async () => {
    const screen = await render(ErrorPage, { status: 404 });

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent('Page not found');
    expect(screen.getByText(/Error 404/).elements()).toHaveLength(0);
    expect(screen.getByLabelText('Email address').elements()).toHaveLength(0);
  });

  it('shows the status code on a failure the copy cannot explain, so a user can quote it', async () => {
    const screen = await render(ErrorPage, { status: 500 });

    await expect.element(screen.getByText('Error 500')).toBeInTheDocument();
  });

  it('signs a 401 in on the spot, then re-runs the loads rather than navigating', async () => {
    const screen = await render(ErrorPage, { status: 401 });

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent('Sign in to continue');
    await screen.getByLabelText('Email address').fill('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();
    await screen.getByLabelText('Sign-in code').fill('123456');

    await expect.poll(() => vi.mocked(refreshAll).mock.calls.length).toBe(1);
    expect(state.auth?.verifyOtp).toHaveBeenCalledExactlyOnceWith({
      email: 'ada@example.com',
      token: '123456',
      type: 'email',
    });
  });

  it('in placeholder mode, signs a 401 in on the spot with the site password', async () => {
    state.mode = 'placeholder';
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(ErrorPage, { status: 401 });

    await expect
      .element(screen.getByRole('heading', { level: 1 }))
      .toHaveTextContent('Sign in to continue');
    expect(screen.getByLabelText('Email address').elements()).toHaveLength(0);
    await screen.getByLabelText('Password').fill('correct horse battery');
    await screen.getByRole('button', { name: 'Sign in' }).click();

    await expect.poll(() => vi.mocked(refreshAll).mock.calls.length).toBe(1);
    expectFetched(fetchMock, {
      url: '/api/site-session',
      method: 'POST',
      body: { password: 'correct horse battery' },
    });
  });

  it('asks a nameless user their name in place, then re-runs the loads rather than navigating', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(ErrorPage, { status: 403, code: 'onboarding_required' });

    await expect.element(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome');
    expect(screen.getByText("You don't have access").elements()).toHaveLength(0);
    await screen.getByLabelText('Your name').fill('Ada Lovelace');
    await screen.getByRole('button', { name: 'Continue' }).click();

    await expect.poll(() => vi.mocked(refreshAll).mock.calls.length).toBe(1);
  });
});
