import { describe, expect, test } from 'vitest';
import { BASE_POLL_INTERVAL_MS, nextPollDelayMs } from './schedule.ts';

const NOT_SETTLED = { settled: false, hidden: false, consecutiveFailures: 0 };

describe('nextPollDelayMs', () => {
  test('stops when the report has settled, regardless of visibility or failures', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, settled: true })).toBeUndefined();
    expect(
      nextPollDelayMs({ settled: true, hidden: false, consecutiveFailures: 3 }),
    ).toBeUndefined();
  });

  test('stops while the tab is hidden, even mid-backoff', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, hidden: true })).toBeUndefined();
    expect(
      nextPollDelayMs({ settled: false, hidden: true, consecutiveFailures: 2 }),
    ).toBeUndefined();
  });

  test('polls at the normal interval once nothing has failed', () => {
    expect(nextPollDelayMs(NOT_SETTLED)).toBe(BASE_POLL_INTERVAL_MS);
  });

  test('doubles the delay per consecutive failure, capped at a minute', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 1 })).toBe(20_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 2 })).toBe(40_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 3 })).toBe(60_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 10 })).toBe(60_000);
  });
});
