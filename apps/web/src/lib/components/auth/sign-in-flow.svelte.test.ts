import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { fakeBrowserAuth } from '$lib/auth/testing/fake';
import SignInFlow from './sign-in-flow.svelte';

/** The two steps are covered by their own files; this is about the wiring between them. */
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
});
