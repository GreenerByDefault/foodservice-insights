import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConfirmAction, { ConfirmActionError } from './confirm-action.svelte';

function baseProps(onConfirm: () => Promise<void>) {
  return {
    title: 'Do the thing?',
    description: 'Are you sure?',
    confirmLabel: 'Yes, do it',
    cancelLabel: 'Cancel',
    errorMessage: 'Could not do the thing. Please try again.',
    onConfirm,
  };
}

describe('ConfirmAction', () => {
  test('a thrown ConfirmActionError shows its own message instead of the generic one', async () => {
    const screen = await render(ConfirmAction, {
      ...baseProps(async () => {
        throw new ConfirmActionError('More specific reason.');
      }),
      open: true,
    });

    await screen.getByRole('button', { name: 'Yes, do it' }).click();

    await expect.element(screen.getByText('More specific reason.')).toBeVisible();
    await expect
      .element(screen.getByText('Could not do the thing. Please try again.'))
      .not.toBeInTheDocument();
  });

  test('any other failure falls back to errorMessage', async () => {
    const screen = await render(ConfirmAction, {
      ...baseProps(async () => {
        throw new Error('unexpected');
      }),
      open: true,
    });

    await screen.getByRole('button', { name: 'Yes, do it' }).click();

    await expect
      .element(screen.getByText('Could not do the thing. Please try again.'))
      .toBeVisible();
  });

  test('success closes the dialog', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const screen = await render(ConfirmAction, { ...baseProps(onConfirm), open: true });

    await screen.getByRole('button', { name: 'Yes, do it' }).click();

    await expect.poll(() => onConfirm.mock.calls.length).toBe(1);
    await expect
      .element(screen.getByRole('heading', { name: 'Do the thing?' }))
      .not.toBeInTheDocument();
  });
});
