import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import {
  forgetPendingCode,
  PENDING_CODE_TTL_MS,
  readPendingCode,
  rememberPendingCode,
} from '#lib/auth/pending-code.js';
import { RESEND_COOLDOWN_S } from '#lib/auth/sign-in.js';
import { fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import SignInFlow from './sign-in-flow.svelte';

/** The two steps are covered by their own files; this is about the wiring between them. */
// Sending a code stores it, and the tests in this file share a document — so a leftover would
// restore the code step in the next test to mount the flow.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetPendingCode();
});

describe('SignInFlow', () => {
  test('a sent code swaps the address field for the code field', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(SignInFlow, { auth, onSignedIn: vi.fn() });

    await screen.getByLabelText('Email address').fill('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
    await expect
      .element(screen.getByText('We sent a code to ada@example.com.'))
      .toBeInTheDocument();
  });

  test('"Change email" goes back with the address still filled in — normalized, as it was sent', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(SignInFlow, { auth, onSignedIn: vi.fn() });

    await screen.getByLabelText('Email address').fill('  Ada@Example.COM  ');
    await screen.getByRole('button', { name: 'Send code' }).click();
    await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Change email' }).click();

    await expect.element(screen.getByLabelText('Email address')).toHaveValue('ada@example.com');
  });

  test('an initial address arrives filled in, and is the one a code is sent to', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(SignInFlow, {
      auth,
      initialEmail: 'ada@example.com',
      onSignedIn: vi.fn(),
    });

    await expect.element(screen.getByLabelText('Email address')).toHaveValue('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      options: { shouldCreateUser: true },
    });
  });

  test('two flows on one document each label their own field', async () => {
    await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn: vi.fn() });
    await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn: vi.fn() });

    const labelled = [...document.querySelectorAll('label')].map((label) => label.control);
    const inputs = [...document.querySelectorAll('input[name="email"]')];
    expect(labelled).toEqual(inputs);
  });

  test('each step swapped in takes focus, which the swap itself would otherwise drop on the body', async () => {
    const auth = fakeBrowserAuth();
    const screen = await render(SignInFlow, { auth, onSignedIn: vi.fn() });

    // Not on arrival: the first email step is the page, not a step moved to.
    expect(document.activeElement).toBe(document.body);

    await screen.getByLabelText('Email address').fill('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();
    await expect
      .poll(() => document.activeElement)
      .toBe(screen.getByLabelText('Sign-in code').element());

    await screen.getByRole('button', { name: 'Change email' }).click();
    await expect
      .poll(() => document.activeElement)
      .toBe(screen.getByLabelText('Email address').element());
  });

  describe('after a reload', () => {
    test('a code sent before it brings back the code step for its address', async () => {
      const auth = fakeBrowserAuth();
      const before = await render(SignInFlow, { auth, onSignedIn: vi.fn() });
      await before.getByLabelText('Email address').fill('Ada@Example.com');
      await before.getByRole('button', { name: 'Send code' }).click();
      await expect.element(before.getByLabelText('Sign-in code')).toBeInTheDocument();
      before.unmount();

      const screen = await render(SignInFlow, { auth, onSignedIn: vi.fn() });

      await expect
        .element(screen.getByText('We sent a code to ada@example.com.'))
        .toBeInTheDocument();
      expect(auth.signInWithOtp).toHaveBeenCalledOnce();
    });

    test('an initial address for the same person still brings back the code step', async () => {
      rememberPendingCode('ada@example.com');
      const screen = await render(SignInFlow, {
        auth: fakeBrowserAuth(),
        initialEmail: 'ada@example.com',
        onSignedIn: vi.fn(),
      });

      await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
    });

    test('an initial address for someone else wins over the stored code', async () => {
      rememberPendingCode('ada@example.com');
      const screen = await render(SignInFlow, {
        auth: fakeBrowserAuth(),
        initialEmail: 'grace@example.com',
        onSignedIn: vi.fn(),
      });

      await expect.element(screen.getByLabelText('Email address')).toHaveValue('grace@example.com');
    });

    test('"Change email" forgets the code, returning to a filled-in field', async () => {
      rememberPendingCode('ada@example.com');
      const screen = await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn: vi.fn() });
      await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();

      await screen.getByRole('button', { name: 'Change email' }).click();

      await expect.element(screen.getByLabelText('Email address')).toHaveValue('ada@example.com');
      screen.unmount();

      const after = await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn: vi.fn() });
      await expect.element(after.getByLabelText('Email address')).toHaveValue('');
    });

    test('a verified code is forgotten before signing in', async () => {
      rememberPendingCode('ada@example.com');
      let storedAtSignIn: string | null | undefined;
      const onSignedIn = vi.fn(async () => {
        storedAtSignIn = readPendingCode();
      });
      const screen = await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn });
      await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();

      await screen.getByLabelText('Sign-in code').fill('123456');

      await expect.poll(() => onSignedIn).toHaveBeenCalledOnce();
      expect(storedAtSignIn).toBeNull();
    });

    test('a new code sent from the code step lasts its own lifetime, not the first one', async () => {
      // Advancing with real time too, so locator retries still run while the clock is faked.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const firstSentAt = Date.now();
      rememberPendingCode('ada@example.com');
      const auth = fakeBrowserAuth();
      const before = await render(SignInFlow, { auth, onSignedIn: vi.fn() });
      await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_S * 1000);
      await before.getByRole('button', { name: 'Send a new code' }).click();
      await expect.poll(() => auth.signInWithOtp).toHaveBeenCalledOnce();
      before.unmount();

      vi.setSystemTime(firstSentAt + PENDING_CODE_TTL_MS);
      const screen = await render(SignInFlow, { auth, onSignedIn: vi.fn() });

      await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
    });

    test('with storage blocked, a code can still be sent and the address changed', async () => {
      vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      const screen = await render(SignInFlow, { auth: fakeBrowserAuth(), onSignedIn: vi.fn() });

      await screen.getByLabelText('Email address').fill('ada@example.com');
      await screen.getByRole('button', { name: 'Send code' }).click();
      await expect.element(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
      await screen.getByRole('button', { name: 'Change email' }).click();

      await expect.element(screen.getByLabelText('Email address')).toHaveValue('ada@example.com');
    });
  });
});
