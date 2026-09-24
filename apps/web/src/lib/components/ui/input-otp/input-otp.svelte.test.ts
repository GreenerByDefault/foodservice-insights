import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Harness from './testing/input-otp-harness.svelte';

function cells(screen: Awaited<ReturnType<typeof render>>): Element[] {
  return [...screen.container.querySelectorAll('[data-slot="input-otp-slot"]')];
}

function activeState(cell: Element): 'active' | 'inactive' | 'neither' {
  if (cell.hasAttribute('data-active')) return 'active';
  return cell.hasAttribute('data-inactive') ? 'inactive' : 'neither';
}

describe('InputOTP', () => {
  // The whole of `input-otp-slot.svelte`'s focus styling keys on these two attributes, and a
  // bits-ui upgrade that renamed them would leave the field with no visible focus indicator at
  // all — the real input is transparent down to its caret. The rest of the primitive is bits-ui's
  // contract, not ours.
  test('marks the cell the caret sits in active and the rest inactive', async () => {
    const screen = await render(Harness, {});

    await screen.getByLabelText('Sign-in code').fill('12');

    expect(cells(screen).map(activeState)).toEqual([
      'inactive',
      'inactive',
      'active',
      'inactive',
      'inactive',
      'inactive',
    ]);
  });
});
