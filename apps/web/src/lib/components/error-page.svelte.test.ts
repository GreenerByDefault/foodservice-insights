import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { invalidateAll } from '$app/navigation';
import ErrorPage from './error-page.svelte';

const auth = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeBrowserAuth> | null }));
vi.mock('#lib/auth/browser.js', () => ({ browserAuth: () => auth.current }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));

beforeEach(() => {
  auth.current = fakeBrowserAuth();
  resetNavigationMocks();
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

    await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
    expect(auth.current?.verifyOtp).toHaveBeenCalledExactlyOnceWith({
      email: 'ada@example.com',
      token: '123456',
      type: 'email',
    });
  });
});
