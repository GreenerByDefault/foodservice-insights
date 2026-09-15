import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RelativeTime from './relative-time.svelte';

const NOW = new Date('2026-01-15T10:00:00Z');

describe('RelativeTime', () => {
  test('defaults to the past direction', async () => {
    const screen = await render(RelativeTime, {
      at: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
      now: NOW,
    });

    await expect.element(screen.getByText('3 days ago')).toBeInTheDocument();
  });

  test('direction "future" reads as a deadline still ahead', async () => {
    const screen = await render(RelativeTime, {
      at: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
      now: NOW,
      direction: 'future',
    });

    await expect.element(screen.getByText('in 3 days')).toBeInTheDocument();
  });

  test('the title attribute always shows the exact timestamp', async () => {
    const at = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    const screen = await render(RelativeTime, { at, now: NOW, direction: 'future' });

    await expect
      .element(screen.getByText('in 3 days'))
      .toHaveAttribute('title', 'Jan 18, 2026, 10:00 AM UTC');
  });
});
