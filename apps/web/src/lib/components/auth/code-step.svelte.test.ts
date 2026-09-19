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

/** The code field, which `InputOTP` renders as one hidden input behind the six cells. */
function codeField(screen: Awaited<ReturnType<typeof render>>) {
  return screen.getByLabelText('Sign-in code');
}

/** A real `paste`, which is the only thing that reaches `pasteTransformer` — `fill` sets the
 * value directly and never goes near it. */
function pasteInto(element: Element, text: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  element.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
  );
}

function cellText(screen: Awaited<ReturnType<typeof render>>): string[] {
  return [...screen.container.querySelectorAll('[data-slot="input-otp-slot"]')].map(
    (cell) => cell.textContent?.trim() ?? '',
  );
}

describe('CodeStep', () => {
  test('verifies the code against the address it was sent to, then hands off', async () => {
    const auth = fakeBrowserAuth();
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    const screen = await render(CodeStep, props(auth, { onSignedIn }));

    await codeField(screen).fill('123456');

    await expect.poll(() => onSignedIn.mock.calls.length).toBe(1);
    // Once, not twice: the sixth digit is the only trigger, and the form locks behind it.
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({
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

    await codeField(screen).fill('123456');

    await expect
      .element(
        screen.getByText(
          'That code is wrong or has expired. Check the latest email, or send a new code.',
        ),
      )
      .toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();

    // The step is live again rather than spent: the next complete code is verified in its turn.
    await codeField(screen).fill('654321');
    await expect.poll(() => auth.verifyOtp.mock.calls.length).toBe(2);
    expect(auth.verifyOtp).toHaveBeenLastCalledWith({
      email: 'ada@example.com',
      token: '654321',
      type: 'email',
    });
  });

  test('stays disabled after a verified code, so the navigation cannot be raced into a second verifyOtp', async () => {
    const auth = fakeBrowserAuth();
    // A real `onSignedIn` navigates; it never resolves back into an interactive form.
    const screen = await render(CodeStep, props(auth, { onSignedIn: () => new Promise(() => {}) }));

    await codeField(screen).fill('123456');

    await expect.element(screen.getByRole('status')).toHaveTextContent('Signing in…');
    await expect.element(codeField(screen)).toBeDisabled();
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

    // Partial: a complete code is verified the moment it lands, so it never sits here to clear.
    await codeField(screen).fill('12345');
    await screen.getByRole('button', { name: 'Send a new code' }).click();

    await expect
      .element(screen.getByRole('button', { name: `Send a new code in ${RESEND_COOLDOWN_S}s` }))
      .toBeDisabled();
    await expect.element(codeField(screen)).toHaveValue('');
  });

  test('a code pasted with the whitespace around it still reaches Supabase as six digits', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(CodeStep, props(auth));

    pasteInto(codeField(screen).element(), ' 123-456\n');

    await expect.poll(() => cellText(screen)).toEqual(['1', '2', '3', '4', '5', '6']);
    await expect.poll(() => auth.verifyOtp.mock.calls.length).toBe(1);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      token: '123456',
      type: 'email',
    });
  });

  test('a rejected code is cleared and the field takes focus back, ready for the next one', async () => {
    const auth = fakeBrowserAuth();
    auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: authError('otp_expired'),
    });
    const screen = await render(CodeStep, props(auth));

    await codeField(screen).fill('123456');

    await expect.element(codeField(screen)).toHaveValue('');
    expect(cellText(screen)).toEqual(['', '', '', '', '', '']);
    await expect.poll(() => document.activeElement).toBe(codeField(screen).element());
  });

  test('an incomplete code is left alone', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(CodeStep, props(auth));

    await codeField(screen).fill('12345');

    await expect.element(screen.getByRole('status')).not.toHaveTextContent('Signing in…');
    expect(auth.verifyOtp).not.toHaveBeenCalled();
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
