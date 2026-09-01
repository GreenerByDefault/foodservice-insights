import { describe, expect, test } from 'vitest';
import { BASE_POLL_INTERVAL_MS, nextPollDelayMs, pollIntervalMsForWorkerMode } from './schedule.ts';

const NOT_SETTLED = {
  reportSettled: false,
  documentHidden: false,
  consecutiveFailures: 0,
  baseIntervalMs: BASE_POLL_INTERVAL_MS,
};

describe('nextPollDelayMs', () => {
  test('stops when the report has settled, regardless of visibility or failures', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, reportSettled: true })).toBeUndefined();
    expect(
      nextPollDelayMs({ ...NOT_SETTLED, reportSettled: true, consecutiveFailures: 3 }),
    ).toBeUndefined();
  });

  test('stops while the tab is hidden, even mid-backoff', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, documentHidden: true })).toBeUndefined();
    expect(
      nextPollDelayMs({ ...NOT_SETTLED, documentHidden: true, consecutiveFailures: 2 }),
    ).toBeUndefined();
  });

  test('polls at the given base interval once nothing has failed', () => {
    expect(nextPollDelayMs(NOT_SETTLED)).toBe(BASE_POLL_INTERVAL_MS);
    expect(nextPollDelayMs({ ...NOT_SETTLED, baseIntervalMs: 1_000 })).toBe(1_000);
  });

  test('doubles the delay per consecutive failure, capped at a minute', () => {
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 1 })).toBe(20_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 2 })).toBe(40_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 3 })).toBe(60_000);
    expect(nextPollDelayMs({ ...NOT_SETTLED, consecutiveFailures: 10 })).toBe(60_000);
  });

  test('the cap applies to a fast base interval too', () => {
    expect(
      nextPollDelayMs({ ...NOT_SETTLED, baseIntervalMs: 1_000, consecutiveFailures: 10 }),
    ).toBe(60_000);
  });
});

describe('pollIntervalMsForWorkerMode', () => {
  test('stubbed gets a faster interval than production', () => {
    expect(pollIntervalMsForWorkerMode('stubbed')).toBeLessThan(BASE_POLL_INTERVAL_MS);
  });

  test.each([['mock-llm'], ['live'], ['off'], ['bogus'], [undefined]])(
    'every other mode (%s) keeps the production interval',
    (mode) => {
      expect(pollIntervalMsForWorkerMode(mode)).toBe(BASE_POLL_INTERVAL_MS);
    },
  );
});
