import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { authError, type FakeBrowserAuth, fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import { refreshAll } from '$app/navigation';
import ChangeEmailForm from './change-email-form.svelte';

vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

afterEach(() => {
  resetNavigationMocks();
  resetToastMocks();
});

const CURRENT_EMAIL = 'sam.cook@example.test';

async function renderForm(auth: FakeBrowserAuth) {
  return await render(ChangeEmailForm, { auth, currentEmail: CURRENT_EMAIL });
}

async function submit(screen: Awaited<ReturnType<typeof renderForm>>, email: string) {
  await screen.getByLabelText('Email').fill(email);
  await screen.getByRole('button', { name: 'Change email' }).click();
}

describe('ChangeEmailForm', () => {
  test('starts out showing the current address', async () => {
    const screen = await renderForm(fakeBrowserAuth());

    await expect.element(screen.getByLabelText('Email')).toHaveValue(CURRENT_EMAIL);
  });

  test('sends a code to the new address, normalized, and asks for it', async () => {
    const auth = fakeBrowserAuth();
    const screen = await renderForm(auth);

    await submit(screen, '  Alex.Baker@Example.TEST ');

    await expect.element(screen.getByLabelText('Confirmation code')).toBeInTheDocument();
    await expect
      .element(screen.getByText('We sent a code to alex.baker@example.test.'))
      .toBeInTheDocument();
    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ email: 'alex.baker@example.test' });
  });

  describe('refused before asking GoTrue', () => {
    test.for([
      [
        'the address the account already has',
        'Sam.Cook@example.test',
        "That's already your email.",
      ],
      ['an address valibot rejects', 'a@b', 'Enter a valid email address.'],
    ] as const)('%s', async ([, email, message]) => {
      const auth = fakeBrowserAuth();
      const screen = await renderForm(auth);

      await submit(screen, email);

      await expect.element(screen.getByText(message)).toBeVisible();
      await expect
        .poll(() => document.activeElement)
        .toBe(screen.getByLabelText('Email').element());
      expect(auth.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('a send that fails stays on the address', () => {
    test('with the refusal mapped to our own copy', async () => {
      const auth = fakeBrowserAuth();
      auth.updateUser.mockResolvedValue({ data: { user: null }, error: authError('email_exists') });
      const screen = await renderForm(auth);

      await submit(screen, 'alex.baker@example.test');

      await expect
        .element(screen.getByText('That address belongs to another account.'))
        .toBeVisible();
      await expect.element(screen.getByRole('button', { name: 'Change email' })).toBeEnabled();
    });

    test('with the fallback when the client could not load', async () => {
      const auth = fakeBrowserAuth();
      auth.updateUser.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
      const screen = await renderForm(auth);

      await submit(screen, 'alex.baker@example.test');

      await expect.element(screen.getByText('Something went wrong. Try again.')).toBeVisible();
    });
  });

  test('a verified code confirms the change, refreshes, and returns to the new address', async () => {
    const auth = fakeBrowserAuth();
    const screen = await renderForm(auth);
    await submit(screen, 'alex.baker@example.test');

    await screen.getByLabelText('Confirmation code').fill('123456');

    await expect.poll(() => vi.mocked(refreshAll).mock.calls.length).toBe(1);
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({
      email: 'alex.baker@example.test',
      token: '123456',
      type: 'email_change',
    });
    expect(toast.success.mock.calls).toEqual([['Changed your email to alex.baker@example.test']]);
    await expect.element(screen.getByLabelText('Email')).toHaveValue('alex.baker@example.test');
    // Gone, rather than stalled: the change landed whatever the refresh did.
    expect(screen.getByRole('button', { name: 'Try again' }).query()).toBeNull();
  });

  test('"Use a different address" goes back with the address still filled in, and focused', async () => {
    const screen = await renderForm(fakeBrowserAuth());
    await submit(screen, 'alex.baker@example.test');

    await screen.getByRole('button', { name: 'Use a different address' }).click();

    await expect.element(screen.getByLabelText('Email')).toHaveValue('alex.baker@example.test');
    await expect.poll(() => document.activeElement).toBe(screen.getByLabelText('Email').element());
  });
});
