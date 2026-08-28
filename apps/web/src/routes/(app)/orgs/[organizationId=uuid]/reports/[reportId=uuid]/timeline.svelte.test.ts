import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Step } from './progress.ts';
import Timeline from './timeline.svelte';

const NOW = new Date('2026-01-15T10:10:00Z');
const RECEIVED_AT = new Date('2026-01-15T10:00:00Z');

const STEPS: Step[] = [
  { stage: 'received', title: 'We checked your file', completedAt: RECEIVED_AT, current: false },
  { stage: 'queued', title: 'Waiting to start', current: true, warning: 'Taking a while.' },
  {
    stage: 'analyzing',
    title: 'Reading your purchases and building your charts',
    current: false,
  },
];

describe('Timeline', () => {
  test('marks only the current step with aria-current="step"', async () => {
    const screen = await render(Timeline, { steps: STEPS, now: NOW });

    const current = screen.getByRole('listitem').filter({ hasText: 'Waiting to start' });
    await expect.element(current).toHaveAttribute('aria-current', 'step');

    const notCurrent = screen.getByRole('listitem').filter({ hasText: 'We checked your file' });
    await expect.element(notCurrent).not.toHaveAttribute('aria-current');
  });

  test('a completed step carries an ISO datetime', async () => {
    const screen = await render(Timeline, { steps: STEPS, now: NOW });

    const item = screen.getByRole('listitem').filter({ hasText: 'We checked your file' });
    const time = item.element().querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(RECEIVED_AT.toISOString());
  });

  test('a step with no completedAt has no time element', async () => {
    const screen = await render(Timeline, { steps: STEPS, now: NOW });

    const item = screen.getByRole('listitem').filter({ hasText: 'Waiting to start' });
    expect(item.element().querySelector('time')).toBeNull();
  });

  test('the warning renders only on the step that carries one', async () => {
    const screen = await render(Timeline, { steps: STEPS, now: NOW });

    await expect.element(screen.getByText('Taking a while.')).toBeVisible();
    await expect
      .element(
        screen
          .getByRole('listitem')
          .filter({ hasText: 'Reading your purchases and building your charts' }),
      )
      .not.toHaveTextContent('Taking a while.');
  });
});
