import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CanceledView from './canceled-view.svelte';

const NOW = new Date('2026-01-15T10:10:00Z');
const STOPPED_AT = new Date('2026-01-15T10:07:00Z');

describe('CanceledView', () => {
  test('says the report was stopped and cannot be run again', async () => {
    const screen = await render(CanceledView, { stoppedAt: STOPPED_AT, now: NOW });

    await expect
      .element(screen.getByText('You stopped this report', { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText('It cannot be run again', { exact: false }))
      .toBeVisible();
  });

  test('the stopped time carries an ISO datetime and a relative rendering', async () => {
    const screen = await render(CanceledView, { stoppedAt: STOPPED_AT, now: NOW });

    const time = screen.container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(STOPPED_AT.toISOString());
    expect(time?.textContent).toBe('3 minutes ago');
  });
});
