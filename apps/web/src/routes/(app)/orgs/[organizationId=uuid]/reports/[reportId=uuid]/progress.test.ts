import { describe, expect, test } from 'vitest';
import { describeProgress, formatElapsed, isWaiting } from './progress.ts';

const CREATED_AT = new Date('2026-01-15T10:00:00Z');
const CLAIMED_AT = new Date('2026-01-15T10:03:00Z');

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

describe('isWaiting', () => {
  test.for(['pending', 'processing'] as const)('%s is waiting', (status) => {
    expect(isWaiting({ status })).toBe(true);
  });

  test.for(['succeeded', 'failed', 'canceled'] as const)('%s is not waiting', (status) => {
    expect(isWaiting({ status })).toBe(false);
  });
});

describe('describeProgress', () => {
  test('pending, fresh: queued is current, no warning', () => {
    const progress = describeProgress(
      { status: 'pending', createdAt: CREATED_AT },
      minutesAfter(CREATED_AT, 1),
    );

    expect(progress.headline).toBe('Waiting to start');
    expect(progress.steps).toEqual([
      { stage: 'received', title: 'We checked your file', completedAt: CREATED_AT, current: false },
      {
        stage: 'queued',
        title: 'Waiting to start',
        completedAt: undefined,
        current: true,
        warning: undefined,
      },
      {
        stage: 'analyzing',
        title: 'Reading your purchases and building your charts',
        current: false,
        warning: undefined,
      },
    ]);
  });

  test('pending, just under two minutes: no warning', () => {
    const progress = describeProgress(
      { status: 'pending', createdAt: CREATED_AT },
      new Date(CREATED_AT.getTime() + 2 * 60_000 - 1),
    );

    expect(progress.steps[1]?.warning).toBeUndefined();
  });

  test('pending, at two minutes: the queue warning appears', () => {
    // getTime() difference is exactly 2 * MINUTE_MS here, and the threshold is `>=`.
    const progress = describeProgress(
      { status: 'pending', createdAt: CREATED_AT },
      new Date(CREATED_AT.getTime() + 2 * 60_000),
    );

    expect(progress.steps[1]?.warning).toBe(
      'It is busier than usual, so this is taking a while to start. Nothing has gone wrong, and ' +
        'there is nothing for you to do.',
    );
  });

  test('processing, fresh: analyzing is current, queued is complete', () => {
    const progress = describeProgress(
      { status: 'processing', createdAt: CREATED_AT, claimedAt: CLAIMED_AT },
      minutesAfter(CLAIMED_AT, 1),
    );

    expect(progress.headline).toBe('Reading your purchases and building your charts');
    expect(progress.steps).toEqual([
      { stage: 'received', title: 'We checked your file', completedAt: CREATED_AT, current: false },
      {
        stage: 'queued',
        title: 'Waiting to start',
        completedAt: CLAIMED_AT,
        current: false,
        warning: undefined,
      },
      {
        stage: 'analyzing',
        title: 'Reading your purchases and building your charts',
        current: true,
        warning: undefined,
      },
    ]);
  });

  test('processing, just under fifteen minutes: no warning', () => {
    const progress = describeProgress(
      { status: 'processing', createdAt: CREATED_AT, claimedAt: CLAIMED_AT },
      minutesAfter(CLAIMED_AT, 15 - 0.001),
    );

    expect(progress.steps[2]?.warning).toBeUndefined();
  });

  test('processing, at fifteen minutes: the analysis warning appears', () => {
    const progress = describeProgress(
      { status: 'processing', createdAt: CREATED_AT, claimedAt: CLAIMED_AT },
      minutesAfter(CLAIMED_AT, 15),
    );

    expect(progress.steps[2]?.warning).toBe(
      'This is taking longer than usual. We are still working on it, and we will email you as ' +
        'soon as it is done.',
    );
  });

  test('processing does not resurrect the queue warning once it is done', () => {
    // The queue step is complete by the time analyzing starts, however long it took to get there.
    const progress = describeProgress(
      { status: 'processing', createdAt: CREATED_AT, claimedAt: minutesAfter(CREATED_AT, 10) },
      minutesAfter(CREATED_AT, 10),
    );

    expect(progress.steps[1]?.warning).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  test('under a minute reads as "less than a minute ago"', () => {
    expect(formatElapsed(new Date(CREATED_AT.getTime() + 59_000), CREATED_AT)).toBe(
      'less than a minute ago',
    );
  });

  test('exactly one minute', () => {
    expect(formatElapsed(minutesAfter(CREATED_AT, 1), CREATED_AT)).toBe('1 minute ago');
  });

  test('several minutes, rounded down', () => {
    expect(formatElapsed(new Date(CREATED_AT.getTime() + 3 * 60_000 + 30_000), CREATED_AT)).toBe(
      '3 minutes ago',
    );
  });
});
