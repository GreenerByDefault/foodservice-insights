import { describe, expect, test } from 'vitest';
import { ContractError } from '../contract/messages.ts';
import {
  type SupervisionAction,
  type SupervisionState,
  type SupervisionThresholds,
  superviseAttempt,
  type TickReading,
} from './supervision.ts';

const THRESHOLDS: SupervisionThresholds = {
  noProgressAfterMs: 1_000,
  hardCeilingMs: 5_000,
  leaseExpiresAfterMs: 300,
  uploadRetryBudgetMs: 200,
};

function aState(overrides: Partial<SupervisionState> = {}): SupervisionState {
  return { startedAt: 0, lastProgressAt: 0, renewalIssuedAt: 0, exited: false, ...overrides };
}

function aReading(overrides: Partial<TickReading> = {}): TickReading {
  return {
    progress: { kind: 'read' },
    lease: { kind: 'held', cancelRequestedAt: null },
    renewalIssuedAt: 0,
    ...overrides,
  };
}

function actionOf(
  state: SupervisionState,
  reading: TickReading,
  now: number,
  thresholds: SupervisionThresholds = THRESHOLDS,
): SupervisionAction {
  return superviseAttempt(state, reading, thresholds, now).action;
}

describe('the rule table', () => {
  describe('lost: a renewal that came back lost', () => {
    test('drops a parked attempt rather than spending its resume budget', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(actionOf(state, reading, 0)).toEqual({ kind: 'drop' });
    });

    test('kills a child still alive', () => {
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(actionOf(aState(), reading, 0)).toEqual({ kind: 'kill', kill: { reason: 'lost' } });
    });

    test('does nothing once the child has already exited', () => {
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(actionOf(aState({ exited: true }), reading, 0)).toEqual({ kind: 'nothing' });
    });
  });

  describe('parked: a parked verdict determines its own fate', () => {
    test('converts to canceled when a cancellation was requested', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
      expect(actionOf(state, reading, 0)).toEqual({ kind: 'convert', to: 'canceled' });
    });

    test('converts an upload past its retry budget to upload-expired', () => {
      const state = aState({ parked: { stage: 'upload', since: 0 } });
      const reading = aReading();
      expect(actionOf(state, reading, THRESHOLDS.uploadRetryBudgetMs)).toEqual({
        kind: 'convert',
        to: 'upload-expired',
      });
    });

    test('resumes an upload still within its retry budget', () => {
      const state = aState({ parked: { stage: 'upload', since: 0 } });
      const reading = aReading();
      expect(actionOf(state, reading, THRESHOLDS.uploadRetryBudgetMs - 1)).toEqual({
        kind: 'resume',
      });
    });

    test('resumes a parked record indefinitely, since only the upload stage has a retry budget', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading();
      expect(actionOf(state, reading, THRESHOLDS.uploadRetryBudgetMs * 100)).toEqual({
        kind: 'resume',
      });
    });
  });

  test('settling: an already-exited attempt is left alone', () => {
    const state = aState({ exited: true, lastProgressAt: -10_000 });
    expect(actionOf(state, aReading(), 0)).toEqual({ kind: 'nothing' });
  });

  test('contract-violation: a progress read that threw a ContractError kills the child with that reason', () => {
    const error = new ContractError('malformed progress.json');
    const reading = aReading({ progress: { kind: 'failed', error } });
    expect(actionOf(aState(), reading, 0)).toEqual({
      kind: 'kill',
      kill: { reason: 'contract-violation', detail: error.message },
    });
  });

  test('progress-read-failed: a progress read that threw anything else is swallowed rather than treated as a verdict', () => {
    const reading = aReading({ progress: { kind: 'failed', error: new Error('EIO') } });
    expect(actionOf(aState(), reading, 0)).toEqual({ kind: 'nothing' });
  });

  test('cancel-requested: a cancellation request kills the child', () => {
    const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
    expect(actionOf(aState(), reading, 0)).toEqual({ kind: 'kill', kill: { reason: 'canceled' } });
  });

  test('hung: no progress for noProgressAfterMs kills as hung', () => {
    expect(actionOf(aState(), aReading(), THRESHOLDS.noProgressAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hung' },
    });
  });

  test('hard-ceiling: running past hardCeilingMs kills as hard-timeout, even with fresh progress', () => {
    const state = aState({ lastProgressAt: THRESHOLDS.hardCeilingMs });
    expect(actionOf(state, aReading(), THRESHOLDS.hardCeilingMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hard-timeout' },
    });
  });

  test('lease-expired: no successful renewal for leaseExpiresAfterMs fences the child', () => {
    const state = aState({
      lastProgressAt: THRESHOLDS.leaseExpiresAfterMs,
      startedAt: THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(actionOf(state, aReading(), THRESHOLDS.leaseExpiresAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'fenced' },
    });
  });

  test('otherwise, nothing', () => {
    expect(actionOf(aState(), aReading(), 0)).toEqual({ kind: 'nothing' });
  });
});

describe('precedence', () => {
  test('parked-lost outranks parked-cancel', () => {
    const state = aState({ parked: { stage: 'record', since: 0 } });
    const reading = aReading({ lease: { kind: 'lost' } });
    expect(actionOf(state, reading, 0)).toEqual({ kind: 'drop' });
  });

  test('lost outranks contract-violation', () => {
    const reading = aReading({
      progress: { kind: 'failed', error: new ContractError('malformed') },
      lease: { kind: 'lost' },
    });
    expect(actionOf(aState(), reading, 0)).toEqual({ kind: 'kill', kill: { reason: 'lost' } });
  });

  test('contract-violation outranks hung', () => {
    const error = new ContractError('malformed');
    const reading = aReading({ progress: { kind: 'failed', error } });
    expect(actionOf(aState(), reading, THRESHOLDS.noProgressAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'contract-violation', detail: error.message },
    });
  });

  test('canceled outranks hung', () => {
    const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
    expect(actionOf(aState(), reading, THRESHOLDS.noProgressAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'canceled' },
    });
  });

  test('hung outranks hard-timeout', () => {
    const state = aState({ startedAt: -THRESHOLDS.hardCeilingMs });
    expect(actionOf(state, aReading(), THRESHOLDS.noProgressAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hung' },
    });
  });

  test('hard-timeout outranks fenced', () => {
    const state = aState({
      lastProgressAt: THRESHOLDS.hardCeilingMs,
      renewalIssuedAt: -THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(actionOf(state, aReading(), THRESHOLDS.hardCeilingMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hard-timeout' },
    });
  });

  test('exited outranks every threshold', () => {
    const state = aState({
      exited: true,
      lastProgressAt: -THRESHOLDS.noProgressAfterMs,
      startedAt: -THRESHOLDS.hardCeilingMs,
      renewalIssuedAt: -THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(actionOf(state, aReading(), 0)).toEqual({ kind: 'nothing' });
  });
});

describe('the state transition', () => {
  test('lastProgressAt is frozen when sequence repeats', () => {
    const state = aState({ lastProgressAt: 0, lastSequence: 3 });
    const reading = aReading({ progress: { kind: 'read', sequence: 3 } });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(0);
    expect(next.lastSequence).toBe(3);
  });

  test('lastProgressAt advances to now when sequence changes', () => {
    const state = aState({ lastProgressAt: 0, lastSequence: 3 });
    const reading = aReading({ progress: { kind: 'read', sequence: 4 } });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(500);
    expect(next.lastSequence).toBe(4);
  });

  test('lastProgressAt stays at startedAt while progress.json has never been written', () => {
    const state = aState({ startedAt: 10, lastProgressAt: 10 });
    const { state: next } = superviseAttempt(state, aReading(), THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(10);
    expect(next.lastSequence).toBeUndefined();
  });

  test('lastProgressAt advances the first time sequence 0 is observed, not just on truthy sequences', () => {
    const state = aState({ startedAt: 10, lastProgressAt: 10 });
    const reading = aReading({ progress: { kind: 'read', sequence: 0 } });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(500);
    expect(next.lastSequence).toBe(0);
  });

  test('renewalIssuedAt advances only on a held lease, to the issue time', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      lease: { kind: 'held', cancelRequestedAt: null },
      renewalIssuedAt: 500,
    });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(500);
  });

  test('renewalIssuedAt is frozen when the lease is held but no renewal was issued this tick', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      lease: { kind: 'held', cancelRequestedAt: null },
      renewalIssuedAt: undefined,
    });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('renewalIssuedAt is frozen when the renewal was skipped', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      progress: { kind: 'failed', error: new Error('EIO') },
      lease: { kind: 'skipped' },
      renewalIssuedAt: undefined,
    });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('renewalIssuedAt is frozen when the renewal statement itself failed', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({ lease: { kind: 'failed', error: new Error('ECONNRESET') } });
    const { state: next } = superviseAttempt(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('every threshold fires at exactly >=, not only strictly past it', () => {
    // A lease renewed on this very tick, so the fencing threshold (hung/hard-ceiling are checked
    // first anyway, but lease-expired has the shortest of the three default thresholds here)
    // never preempts the boundary this sub-case is actually about.
    const freshLease = (now: number) => aReading({ renewalIssuedAt: now });

    expect(
      actionOf(
        aState(),
        freshLease(THRESHOLDS.noProgressAfterMs - 1),
        THRESHOLDS.noProgressAfterMs - 1,
      ),
    ).toEqual({ kind: 'nothing' });
    expect(
      actionOf(aState(), freshLease(THRESHOLDS.noProgressAfterMs), THRESHOLDS.noProgressAfterMs),
    ).toEqual({ kind: 'kill', kill: { reason: 'hung' } });

    const pastHung = aState({ lastProgressAt: THRESHOLDS.hardCeilingMs });
    expect(
      actionOf(pastHung, freshLease(THRESHOLDS.hardCeilingMs - 1), THRESHOLDS.hardCeilingMs - 1),
    ).toEqual({ kind: 'nothing' });
    expect(
      actionOf(pastHung, freshLease(THRESHOLDS.hardCeilingMs), THRESHOLDS.hardCeilingMs),
    ).toEqual({ kind: 'kill', kill: { reason: 'hard-timeout' } });

    const pastHungAndCeiling = aState({
      lastProgressAt: THRESHOLDS.leaseExpiresAfterMs,
      startedAt: THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(actionOf(pastHungAndCeiling, aReading(), THRESHOLDS.leaseExpiresAfterMs - 1)).toEqual({
      kind: 'nothing',
    });
    expect(actionOf(pastHungAndCeiling, aReading(), THRESHOLDS.leaseExpiresAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'fenced' },
    });

    const parkedUpload = aState({ parked: { stage: 'upload', since: 0 } });
    expect(actionOf(parkedUpload, aReading(), THRESHOLDS.uploadRetryBudgetMs - 1)).toEqual({
      kind: 'resume',
    });
    expect(actionOf(parkedUpload, aReading(), THRESHOLDS.uploadRetryBudgetMs)).toEqual({
      kind: 'convert',
      to: 'upload-expired',
    });
  });
});
