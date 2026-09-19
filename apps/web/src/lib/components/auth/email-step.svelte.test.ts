import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { authError, fakeBrowserAuth } from '$lib/auth/testing/fake';
import EmailStep from './email-step.svelte';

describe('EmailStep', () => {
  test('sends a code to the trimmed, lowercased address and advances', async () => {
    const auth = fakeBrowserAuth();
    const onCodeSent = vi.fn();
    const screen = await render(EmailStep, { auth, email: '', onCodeSent });

    await screen.getByLabelText('Email address').fill('  Ada@Example.COM  ');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect.poll(() => onCodeSent.mock.calls.length).toBe(1);
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      options: { shouldCreateUser: true },
    });
  });

  test('rejects an address the email input accepts but the schema does not, without calling Supabase', async () => {
    const auth = fakeBrowserAuth();
    const onCodeSent = vi.fn();
    const screen = await render(EmailStep, { auth, email: '', onCodeSent });

    await screen.getByLabelText('Email address').fill('ada@example');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect.element(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
    expect(onCodeSent).not.toHaveBeenCalled();
  });

  test('a rejected send stays on the step with the error mapped to our own copy', async () => {
    const auth = fakeBrowserAuth();
    auth.signInWithOtp.mockResolvedValue({
      data: { user: null, session: null, messageId: null },
      error: authError('over_email_send_rate_limit'),
    });
    const onCodeSent = vi.fn();
    const screen = await render(EmailStep, { auth, email: '', onCodeSent });

    await screen.getByLabelText('Email address').fill('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect
      .element(screen.getByText('Too many codes requested. Wait a minute, then try again.'))
      .toBeInTheDocument();
    expect(onCodeSent).not.toHaveBeenCalled();
  });

  test('the button disables and swaps its label while the send is in flight', async () => {
    const auth = fakeBrowserAuth();
    auth.signInWithOtp.mockReturnValue(new Promise(() => {}));
    const screen = await render(EmailStep, { auth, email: '', onCodeSent: vi.fn() });

    await screen.getByLabelText('Email address').fill('ada@example.com');
    await screen.getByRole('button', { name: 'Send code' }).click();

    await expect.element(screen.getByRole('button', { name: 'Sending code…' })).toBeDisabled();
  });
});
