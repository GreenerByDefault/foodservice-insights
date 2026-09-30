import { collectingLogger } from '@gbd/core/testing';
import { aDatabaseError, anUnreachableDatabaseError } from '@gbd/db/testing';
import { aBlobStoreError } from '@gbd/storage/testing';
import { describe, expect, it } from 'vitest';
import { classifyAttemptFailure, failureStreak } from './failures.ts';
import { manualClock } from './testing/clock.ts';

describe('classifyAttemptFailure', () => {
  it.each([
    ['an unreachable database', anUnreachableDatabaseError(), 'infrastructure', 'database'],
    ['a refused statement', aDatabaseError('duplicate key', '23505'), 'infrastructure', '23505'],
    ['a blob store failure', aBlobStoreError(), 'infrastructure', 'blob store'],
    ['an unrecognised Error', new TypeError('boom'), 'unknown', 'boom'],
    ['a thrown non-Error', 'just a string', 'unknown', 'just a string'],
  ])('maps %s', (_name, error, reason, detailFragment) => {
    const failure = classifyAttemptFailure(error);
    expect(failure.reason).toBe(reason);
    expect(failure.detail).toContain(detailFragment);
  });
});

describe('failureStreak', () => {
  const MESSAGES = { failed: 'The loop failed', recovered: 'The loop recovered' };

  it('logs the first failure and the recovery, and nothing in between', () => {
    const clock = manualClock();
    const { log, records } = collectingLogger();
    const streak = failureStreak(log, clock, MESSAGES);

    streak.failed(new Error('first'));
    clock.advance(2_000);
    streak.failed(new Error('second'));
    clock.advance(2_000);
    streak.failed(new Error('third'));
    clock.advance(2_000);
    streak.succeeded();

    expect(records).toEqual([
      {
        level: 'error',
        msg: 'The loop failed',
        err: expect.objectContaining({ type: 'Error', message: 'first' }),
      },
      { level: 'info', msg: 'The loop recovered', durationMs: 6_000, failedTicks: 3 },
    ]);
  });

  it('logs nothing while the loop succeeds', () => {
    const { log, records } = collectingLogger();
    const streak = failureStreak(log, manualClock(), MESSAGES);

    streak.succeeded();
    streak.succeeded();

    expect(records).toEqual([]);
  });

  it('starts a new streak after a recovery', () => {
    const { log, records } = collectingLogger();
    const streak = failureStreak(log, manualClock(), MESSAGES);

    streak.failed(new Error('first'));
    streak.succeeded();
    streak.failed(new Error('again'));

    expect(records.map((record) => record.msg)).toEqual([
      'The loop failed',
      'The loop recovered',
      'The loop failed',
    ]);
  });
});
