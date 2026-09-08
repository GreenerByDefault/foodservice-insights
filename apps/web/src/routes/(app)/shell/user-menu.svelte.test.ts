import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UserMenu from './user-menu.svelte';

/** Opens the menu and returns the screen — the content is portalled, so it only exists once open. */
async function opened(props: { email: string; displayName: string | null }) {
  const screen = await render(UserMenu, props);
  await screen.getByRole('button', { name: 'Account menu' }).click();
  return screen;
}

describe('UserMenu', () => {
  test('the trigger shows the monogram for a display name', async () => {
    const screen = await render(UserMenu, {
      email: 'ana@example.test',
      displayName: 'Ana Ruiz',
    });

    await expect
      .element(screen.getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('AR');
  });

  test('the trigger falls back to an icon when there is no display name', async () => {
    const screen = await render(UserMenu, { email: 'ana@example.test', displayName: null });

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await expect.poll(() => trigger.element().querySelector('svg')).not.toBeNull();
  });

  test('the open menu shows the display name and email', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect.element(screen.getByText('Ana Ruiz')).toBeVisible();
    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('the open menu shows only the email when there is no display name', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: null });

    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('the open menu links Account to /account', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Account' }))
      .toHaveAttribute('href', '/account');
  });

  test('sign out is present but disabled', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Sign out' }))
      .toHaveAttribute('data-disabled');
  });
});
