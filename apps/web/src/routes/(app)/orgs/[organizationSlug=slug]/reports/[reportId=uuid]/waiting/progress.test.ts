import { describe, expect, test } from 'vitest';
import { describeProgress } from './progress.ts';

const CREATED_AT = new Date('2026-01-15T10:00:00Z');
const CLAIMED_AT = new Date('2026-01-15T10:03:00Z');

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

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
        description:
          'We run a few reports at a time, so yours starts as soon as there is room — usually ' +
          'straight away.',
        warning: undefined,
      },
      {
        stage: 'analyzing',
        title: 'Reading your purchases and building your charts',
        current: false,
        description: undefined,
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
        description: undefined,
        warning: undefined,
      },
      {
        stage: 'analyzing',
        title: 'Reading your purchases and building your charts',
        current: true,
        description: 'This usually takes about five minutes.',
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
