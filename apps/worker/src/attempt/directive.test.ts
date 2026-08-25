import { describe, expect, test } from 'vitest';
import { ContractError } from '../contract/messages.ts';
import {
  type AttemptDirective,
  decideDirective,
  type TickReading,
  type TickState,
  type TickThresholds,
} from './directive.ts';

const THRESHOLDS: TickThresholds = {
  killAfterNoProgressMs: 1_000,
  killAfterTotalRuntimeMs: 5_000,
  leaseExpiresAfterMs: 300,
  uploadRetryBudgetMs: 200,
};

function aState(overrides: Partial<TickState> = {}): TickState {
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

function directiveOf(
  state: TickState,
  reading: TickReading,
  now: number,
  thresholds: TickThresholds = THRESHOLDS,
): AttemptDirective {
  return decideDirective(state, reading, thresholds, now).directive;
}

describe('the rule table', () => {
  describe('lost: a renewal that came back lost', () => {
    test('drops a parked attempt rather than spending its resume budget', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(directiveOf(state, reading, 0)).toEqual({ kind: 'drop-parked-verdict' });
    });

    test('kills a child still alive', () => {
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(directiveOf(aState(), reading, 0)).toEqual({ kind: 'kill', kill: { reason: 'lost' } });
    });

    test('does nothing once the child has already exited', () => {
      const reading = aReading({ lease: { kind: 'lost' } });
      expect(directiveOf(aState({ exited: true }), reading, 0)).toEqual({ kind: 'nothing' });
    });
  });

  describe('parked: a parked verdict determines its own fate', () => {
    test('converts to canceled when a cancellation was requested', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
      expect(directiveOf(state, reading, 0)).toEqual({
        kind: 'convert-parked-verdict-to-canceled',
      });
    });

    test('converts an upload past its retry budget to upload-expired', () => {
      const state = aState({ parked: { stage: 'upload', since: 0 } });
      const reading = aReading();
      expect(directiveOf(state, reading, THRESHOLDS.uploadRetryBudgetMs)).toEqual({
        kind: 'convert-parked-verdict-to-upload-expired',
      });
    });

    test('resumes an upload still within its retry budget', () => {
      const state = aState({ parked: { stage: 'upload', since: 0 } });
      const reading = aReading();
      expect(directiveOf(state, reading, THRESHOLDS.uploadRetryBudgetMs - 1)).toEqual({
        kind: 'resume-parked-verdict',
      });
    });

    test('resumes a parked record indefinitely, since only the upload stage has a retry budget', () => {
      const state = aState({ parked: { stage: 'record', since: 0 } });
      const reading = aReading();
      expect(directiveOf(state, reading, THRESHOLDS.uploadRetryBudgetMs * 100)).toEqual({
        kind: 'resume-parked-verdict',
      });
    });
  });

  test('settling: an already-exited attempt is left alone', () => {
    const state = aState({ exited: true, lastProgressAt: -10_000 });
    expect(directiveOf(state, aReading(), 0)).toEqual({ kind: 'nothing' });
  });

  test('contract-violation: a progress read that threw a ContractError kills the child with that reason', () => {
    const error = new ContractError('malformed progress.json');
    const reading = aReading({ progress: { kind: 'failed', error } });
    expect(directiveOf(aState(), reading, 0)).toEqual({
      kind: 'kill',
      kill: { reason: 'contract-violation', detail: error.message },
    });
  });

  test('progress-read-failed: a progress read that threw anything else is swallowed rather than treated as a verdict', () => {
    const reading = aReading({ progress: { kind: 'failed', error: new Error('EIO') } });
    expect(directiveOf(aState(), reading, 0)).toEqual({ kind: 'nothing' });
  });

  test('progress-read-failed suppresses hung, since an unreadable file is not a stalled child', () => {
    const reading = aReading({
      progress: { kind: 'failed', error: new Error('EIO') },
      lease: { kind: 'skipped' },
      renewalIssuedAt: undefined,
    });
    // The other two clock rules are pushed out of range, so `hung` is the only one that could
    // fire here — and it does not.
    const thresholds = {
      ...THRESHOLDS,
      killAfterTotalRuntimeMs: 10_000,
      leaseExpiresAfterMs: 10_000,
    };
    expect(directiveOf(aState(), reading, THRESHOLDS.killAfterNoProgressMs, thresholds)).toEqual({
      kind: 'nothing',
    });
  });

  test('progress-read-failed still lets hard-timeout fire', () => {
    const reading = aReading({ progress: { kind: 'failed', error: new Error('EIO') } });
    expect(directiveOf(aState(), reading, THRESHOLDS.killAfterTotalRuntimeMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hard-timeout' },
    });
  });

  // The case that closes the gap: a progress read failing every tick also skips every renewal
  // (`no-check-no-renewal`), so fencing is the only local rule left that can end the child.
  test('progress-read-failed still lets lease-expired fence, with the renewal skipped alongside', () => {
    const reading = aReading({
      progress: { kind: 'failed', error: new Error('EIO') },
      lease: { kind: 'skipped' },
      renewalIssuedAt: undefined,
    });
    expect(directiveOf(aState(), reading, THRESHOLDS.leaseExpiresAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'fenced' },
    });
  });

  test('cancel-requested: a cancellation request kills the child', () => {
    const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
    expect(directiveOf(aState(), reading, 0)).toEqual({
      kind: 'kill',
      kill: { reason: 'canceled' },
    });
  });

  test('hung: no progress for killAfterNoProgressMs kills as hung', () => {
    expect(directiveOf(aState(), aReading(), THRESHOLDS.killAfterNoProgressMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hung' },
    });
  });

  test('hard-timeout: running past killAfterTotalRuntimeMs kills as hard-timeout, even with fresh progress', () => {
    const state = aState({ lastProgressAt: THRESHOLDS.killAfterTotalRuntimeMs });
    expect(directiveOf(state, aReading(), THRESHOLDS.killAfterTotalRuntimeMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hard-timeout' },
    });
  });

  test('lease-expired: no successful renewal for leaseExpiresAfterMs fences the child', () => {
    const state = aState({
      lastProgressAt: THRESHOLDS.leaseExpiresAfterMs,
      startedAt: THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(directiveOf(state, aReading(), THRESHOLDS.leaseExpiresAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'fenced' },
    });
  });

  test('otherwise, nothing', () => {
    expect(directiveOf(aState(), aReading(), 0)).toEqual({ kind: 'nothing' });
  });
});

describe('precedence', () => {
  test('parked-lost outranks parked-cancel', () => {
    const state = aState({ parked: { stage: 'record', since: 0 } });
    const reading = aReading({ lease: { kind: 'lost' } });
    expect(directiveOf(state, reading, 0)).toEqual({ kind: 'drop-parked-verdict' });
  });

  test('lost outranks contract-violation', () => {
    const reading = aReading({
      progress: { kind: 'failed', error: new ContractError('malformed') },
      lease: { kind: 'lost' },
    });
    expect(directiveOf(aState(), reading, 0)).toEqual({ kind: 'kill', kill: { reason: 'lost' } });
  });

  test('contract-violation outranks hung', () => {
    const error = new ContractError('malformed');
    const reading = aReading({ progress: { kind: 'failed', error } });
    expect(directiveOf(aState(), reading, THRESHOLDS.killAfterNoProgressMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'contract-violation', detail: error.message },
    });
  });

  test('canceled outranks hung', () => {
    const reading = aReading({ lease: { kind: 'held', cancelRequestedAt: new Date() } });
    expect(directiveOf(aState(), reading, THRESHOLDS.killAfterNoProgressMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'canceled' },
    });
  });

  test('hung outranks hard-timeout', () => {
    const state = aState({ startedAt: -THRESHOLDS.killAfterTotalRuntimeMs });
    expect(directiveOf(state, aReading(), THRESHOLDS.killAfterNoProgressMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hung' },
    });
  });

  test('hard-timeout outranks fenced', () => {
    const state = aState({
      lastProgressAt: THRESHOLDS.killAfterTotalRuntimeMs,
      renewalIssuedAt: -THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(directiveOf(state, aReading(), THRESHOLDS.killAfterTotalRuntimeMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'hard-timeout' },
    });
  });

  test('exited outranks every threshold', () => {
    const state = aState({
      exited: true,
      lastProgressAt: -THRESHOLDS.killAfterNoProgressMs,
      startedAt: -THRESHOLDS.killAfterTotalRuntimeMs,
      renewalIssuedAt: -THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(directiveOf(state, aReading(), 0)).toEqual({ kind: 'nothing' });
  });
});

describe('the state transition', () => {
  test('lastProgressAt is frozen when progressSequence repeats', () => {
    const state = aState({ lastProgressAt: 0, lastProgressSequence: 3 });
    const reading = aReading({ progress: { kind: 'read', progressSequence: 3 } });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(0);
    expect(next.lastProgressSequence).toBe(3);
  });

  test('lastProgressAt advances to now when progressSequence changes', () => {
    const state = aState({ lastProgressAt: 0, lastProgressSequence: 3 });
    const reading = aReading({ progress: { kind: 'read', progressSequence: 4 } });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(500);
    expect(next.lastProgressSequence).toBe(4);
  });

  test('lastProgressAt stays at startedAt while progress.json has never been written', () => {
    const state = aState({ startedAt: 10, lastProgressAt: 10 });
    const { state: next } = decideDirective(state, aReading(), THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(10);
    expect(next.lastProgressSequence).toBeUndefined();
  });

  test('lastProgressAt advances the first time progressSequence 0 is observed, not just on truthy sequences', () => {
    const state = aState({ startedAt: 10, lastProgressAt: 10 });
    const reading = aReading({ progress: { kind: 'read', progressSequence: 0 } });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.lastProgressAt).toBe(500);
    expect(next.lastProgressSequence).toBe(0);
  });

  test('renewalIssuedAt advances only on a held lease, to the issue time', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      lease: { kind: 'held', cancelRequestedAt: null },
      renewalIssuedAt: 500,
    });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(500);
  });

  test('renewalIssuedAt is frozen when the lease is held but no renewal was issued this tick', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      lease: { kind: 'held', cancelRequestedAt: null },
      renewalIssuedAt: undefined,
    });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('renewalIssuedAt is frozen when the renewal was skipped', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({
      progress: { kind: 'failed', error: new Error('EIO') },
      lease: { kind: 'skipped' },
      renewalIssuedAt: undefined,
    });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('renewalIssuedAt is frozen when the renewal statement itself failed', () => {
    const state = aState({ renewalIssuedAt: 0 });
    const reading = aReading({ lease: { kind: 'failed', error: new Error('ECONNRESET') } });
    const { state: next } = decideDirective(state, reading, THRESHOLDS, 500);
    expect(next.renewalIssuedAt).toBe(0);
  });

  test('every threshold fires at exactly >=, not only strictly past it', () => {
    // Keep the lease renewed on this very tick throughout. Lease-expired has the shortest
    // of the three default thresholds, so an unrenewed lease would fire before the
    // hung/hard-timeout boundary each sub-case is actually testing (those two are checked
    // first anyway, but there's no reason to rely on that ordering here).
    const freshLease = (now: number) => aReading({ renewalIssuedAt: now });

    expect(
      directiveOf(
        aState(),
        freshLease(THRESHOLDS.killAfterNoProgressMs - 1),
        THRESHOLDS.killAfterNoProgressMs - 1,
      ),
    ).toEqual({ kind: 'nothing' });
    expect(
      directiveOf(
        aState(),
        freshLease(THRESHOLDS.killAfterNoProgressMs),
        THRESHOLDS.killAfterNoProgressMs,
      ),
    ).toEqual({ kind: 'kill', kill: { reason: 'hung' } });

    const pastHung = aState({ lastProgressAt: THRESHOLDS.killAfterTotalRuntimeMs });
    expect(
      directiveOf(
        pastHung,
        freshLease(THRESHOLDS.killAfterTotalRuntimeMs - 1),
        THRESHOLDS.killAfterTotalRuntimeMs - 1,
      ),
    ).toEqual({ kind: 'nothing' });
    expect(
      directiveOf(
        pastHung,
        freshLease(THRESHOLDS.killAfterTotalRuntimeMs),
        THRESHOLDS.killAfterTotalRuntimeMs,
      ),
    ).toEqual({ kind: 'kill', kill: { reason: 'hard-timeout' } });

    const pastHungAndCeiling = aState({
      lastProgressAt: THRESHOLDS.leaseExpiresAfterMs,
      startedAt: THRESHOLDS.leaseExpiresAfterMs,
    });
    expect(directiveOf(pastHungAndCeiling, aReading(), THRESHOLDS.leaseExpiresAfterMs - 1)).toEqual(
      {
        kind: 'nothing',
      },
    );
    expect(directiveOf(pastHungAndCeiling, aReading(), THRESHOLDS.leaseExpiresAfterMs)).toEqual({
      kind: 'kill',
      kill: { reason: 'fenced' },
    });

    const parkedUpload = aState({ parked: { stage: 'upload', since: 0 } });
    expect(directiveOf(parkedUpload, aReading(), THRESHOLDS.uploadRetryBudgetMs - 1)).toEqual({
      kind: 'resume-parked-verdict',
    });
    expect(directiveOf(parkedUpload, aReading(), THRESHOLDS.uploadRetryBudgetMs)).toEqual({
      kind: 'convert-parked-verdict-to-upload-expired',
    });
  });
});
