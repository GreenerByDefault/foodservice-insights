import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { RESEND_COOLDOWN_S } from '$lib/auth/sign-in';
import { authError, type FakeBrowserAuth, fakeBrowserAuth } from '$lib/auth/testing/fake';
import CodeStep from './code-step.svelte';

function props(auth: FakeBrowserAuth, overrides: { onSignedIn?: () => Promise<void> } = {}) {
  return {
    auth,
    email: 'ada@example.com',
    onSignedIn: overrides.onSignedIn ?? vi.fn().mockResolvedValue(undefined),
    onChangeEmail: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CodeStep', () => {
  test('verifies the code against the address it was sent to, then hands off', async () => {
    const auth = fakeBrowserAuth();
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    const screen = await render(CodeStep, props(auth, { onSignedIn }));

    await screen.getByLabelText('Sign-in code').fill('123456');
    await screen.getByRole('button', { name: 'Sign in' }).click();

    await expect.poll(() => onSignedIn.mock.calls.length).toBe(1);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      token: '123456',
      type: 'email',
    });
  });

  test('a rejected code stays on the step with the error mapped to our own copy', async () => {
    const auth = fakeBrowserAuth();
    auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: authError('otp_expired'),
    });
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    const screen = await render(CodeStep, props(auth, { onSignedIn }));

    await screen.getByLabelText('Sign-in code').fill('123456');
    await screen.getByRole('button', { name: 'Sign in' }).click();

    await expect
      .element(
        screen.getByText(
          'That code is wrong or has expired. Check the latest email, or send a new code.',
        ),
      )
      .toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
    await expect.element(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('stays disabled after a verified code, so the navigation cannot be raced into a second verifyOtp', async () => {
    const auth = fakeBrowserAuth();
    // A real `onSignedIn` navigates; it never resolves back into an interactive form.
    const screen = await render(CodeStep, props(auth, { onSignedIn: () => new Promise(() => {}) }));

    await screen.getByLabelText('Sign-in code').fill('123456');
    await screen.getByRole('button', { name: 'Sign in' }).click();

    await expect.element(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });

  test('resend is held for the cooldown, then sends without creating a user', async () => {
    // Fake timers only until the countdown is spent: a locator action while they are installed
    // would have its own retries frozen along with the clock.
    vi.useFakeTimers();
    const auth = fakeBrowserAuth();
    const screen = await render(CodeStep, props(auth));

    const waiting = screen.getByRole('button', {
      name: `Send a new code in ${RESEND_COOLDOWN_S}s`,
    });
    expect(waiting.element()).toBeDisabled();

    await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_S * 1000);
    vi.useRealTimers();

    await screen.getByRole('button', { name: 'Send a new code' }).click();

    await expect.poll(() => auth.signInWithOtp.mock.calls.length).toBe(1);
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      options: { shouldCreateUser: false },
    });
  });

  test('a successful resend clears the typed code and restarts the cooldown', async () => {
    vi.useFakeTimers();
    const auth = fakeBrowserAuth();
    const screen = await render(CodeStep, props(auth));
    await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_S * 1000);
    vi.useRealTimers();

    await screen.getByLabelText('Sign-in code').fill('123456');
    await screen.getByRole('button', { name: 'Send a new code' }).click();

    await expect
      .element(screen.getByRole('button', { name: `Send a new code in ${RESEND_COOLDOWN_S}s` }))
      .toBeDisabled();
    await expect.element(screen.getByLabelText('Sign-in code')).toHaveValue('');
  });

  test('a rejected resend reports it and leaves the button ready to try again', async () => {
    vi.useFakeTimers();
    const auth = fakeBrowserAuth();
    auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null, messageId: null },
      error: authError('over_email_send_rate_limit'),
    });
    const screen = await render(CodeStep, props(auth));
    await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_S * 1000);
    vi.useRealTimers();

    await screen.getByRole('button', { name: 'Send a new code' }).click();

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Too many codes requested. Wait a minute, then try again.');
    await expect.element(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
  });
});
