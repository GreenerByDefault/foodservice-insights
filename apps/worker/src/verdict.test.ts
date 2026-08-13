import { describe, expect, test } from 'vitest';
import type { ChildOutcome } from './child.ts';
import { ContractError } from './contract/messages.ts';
import { type ChildEnding, classifyVerdict, type Kill } from './verdict.ts';

const EXITED_0: ChildOutcome = { kind: 'exited', exitCode: 0, stderrTail: '' };
const EXITED_1: ChildOutcome = { kind: 'exited', exitCode: 1, stderrTail: '' };

const A_RESULT: ChildEnding['result'] = {
  analysisAttemptId: '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  charts: ['total_spend'],
  ai: {
    model: 'gemini-3-pro',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: '1.2345',
    metadata: {},
  },
  resultMetadata: {},
};

const A_FAILURE: ChildEnding['failure'] = {
  reason: 'upstream_api',
  detail: 'the AI provider returned a 503',
  traceback: null,
};

function anEnding(overrides: Partial<ChildEnding> = {}): ChildEnding {
  return { outcome: EXITED_0, missingResultFiles: [], ...overrides };
}

describe('classifyVerdict', () => {
  describe('fenced or lost', () => {
    for (const reason of ['fenced', 'lost'] as const) {
      test(`${reason} is unowned and writes nothing`, () => {
        const kill: Kill = { reason };
        expect(classifyVerdict(anEnding({ kill }))).toEqual({ kind: 'unowned' });
      });

      test(`${reason} outranks a child that finished with a good result`, () => {
        const kill: Kill = { reason };
        expect(classifyVerdict(anEnding({ kill, outcome: EXITED_0, result: A_RESULT }))).toEqual({
          kind: 'unowned',
        });
      });
    }
  });

  describe('canceled', () => {
    test('is a canceled verdict', () => {
      expect(classifyVerdict(anEnding({ kill: { reason: 'canceled' } }))).toEqual({
        kind: 'canceled',
      });
    });

    test('outranks a child that finished with a good result', () => {
      expect(
        classifyVerdict(
          anEnding({ kill: { reason: 'canceled' }, outcome: EXITED_0, result: A_RESULT }),
        ),
      ).toEqual({ kind: 'canceled' });
    });
  });

  test('a spawn failure is infrastructure', () => {
    const outcome: ChildOutcome = { kind: 'spawn-failed', error: new Error('ENOENT') };
    expect(classifyVerdict(anEnding({ outcome }))).toEqual({
      kind: 'failed',
      reason: 'infrastructure',
      detail: 'could not start the child: ENOENT',
    });
  });

  describe("the child's own verdict", () => {
    test('exit 0 with a complete result succeeds', () => {
      expect(classifyVerdict(anEnding({ outcome: EXITED_0, result: A_RESULT }))).toEqual({
        kind: 'succeeded',
        result: A_RESULT,
      });
    });

    test('exit 1 with a failure document fails with the reason the child gave', () => {
      expect(classifyVerdict(anEnding({ outcome: EXITED_1, failure: A_FAILURE }))).toEqual({
        kind: 'failed',
        reason: A_FAILURE.reason,
        detail: A_FAILURE.detail,
      });
    });

    test('outranks a kill for being hung, hard-timeout, shutting-down, or a progress violation', () => {
      const kills: Kill[] = [
        { reason: 'hung' },
        { reason: 'hard-timeout' },
        { reason: 'shutting-down' },
        { reason: 'contract-violation', detail: 'progress.json was not valid JSON' },
      ];
      for (const kill of kills) {
        expect(classifyVerdict(anEnding({ kill, outcome: EXITED_0, result: A_RESULT }))).toEqual({
          kind: 'succeeded',
          result: A_RESULT,
        });
      }
    });
  });

  describe('a kill that the child did not beat to the finish', () => {
    test('hung', () => {
      const verdict = classifyVerdict(anEnding({ kill: { reason: 'hung' } }));
      expect(verdict).toMatchObject({ kind: 'failed', reason: 'hung' });
    });

    test('hard-timeout', () => {
      const verdict = classifyVerdict(anEnding({ kill: { reason: 'hard-timeout' } }));
      expect(verdict).toMatchObject({ kind: 'failed', reason: 'hard_timeout' });
    });

    test('shutting-down', () => {
      const verdict = classifyVerdict(anEnding({ kill: { reason: 'shutting-down' } }));
      expect(verdict).toMatchObject({ kind: 'failed', reason: 'shut_down' });
    });

    test('contract-violation carries the kill detail', () => {
      const kill: Kill = { reason: 'contract-violation', detail: 'progress.json: not valid JSON' };
      expect(classifyVerdict(anEnding({ kill }))).toEqual({
        kind: 'failed',
        reason: 'contract_violation',
        detail: kill.detail,
      });
    });
  });

  describe('a read that threw', () => {
    test('a ContractError is a contract violation', () => {
      const readError = new ContractError('result.json: not valid JSON');
      expect(classifyVerdict(anEnding({ outcome: EXITED_0, readError }))).toEqual({
        kind: 'failed',
        reason: 'contract_violation',
        detail: readError.message,
      });
    });

    test('anything else is infrastructure', () => {
      const readError = Object.assign(new Error('EIO'), { code: 'EIO' });
      expect(classifyVerdict(anEnding({ outcome: EXITED_0, readError }))).toEqual({
        kind: 'failed',
        reason: 'infrastructure',
        detail: 'EIO',
      });
    });
  });

  describe('an exit that never produced its document', () => {
    test('exit 0, a result that parsed, but a declared file missing', () => {
      const verdict = classifyVerdict(
        anEnding({
          outcome: EXITED_0,
          result: A_RESULT,
          missingResultFiles: ['report.pdf', 'chart-total_spend.png'],
        }),
      );
      expect(verdict).toEqual({
        kind: 'failed',
        reason: 'contract_violation',
        detail: 'result.json declared file(s) never written: report.pdf, chart-total_spend.png',
      });
    });

    test('exit 0 with no result.json at all', () => {
      expect(classifyVerdict(anEnding({ outcome: EXITED_0 }))).toEqual({
        kind: 'failed',
        reason: 'contract_violation',
        detail: 'exited 0 without writing result.json',
      });
    });

    test('exit 1 with no failure.json', () => {
      expect(classifyVerdict(anEnding({ outcome: EXITED_1 }))).toEqual({
        kind: 'failed',
        reason: 'contract_violation',
        detail: 'exited 1 without writing failure.json',
      });
    });
  });

  describe('a crash', () => {
    test('killed by a signal we did not send', () => {
      const outcome: ChildOutcome = { kind: 'signaled', signal: 'SIGSEGV', stderrTail: 'oops' };
      expect(classifyVerdict(anEnding({ outcome }))).toEqual({
        kind: 'failed',
        reason: 'child_crashed',
        detail: 'killed by signal SIGSEGV\noops',
      });
    });

    test('an exit code that is neither 0 nor 1', () => {
      const outcome: ChildOutcome = { kind: 'exited', exitCode: 3, stderrTail: 'traceback' };
      expect(classifyVerdict(anEnding({ outcome }))).toEqual({
        kind: 'failed',
        reason: 'child_crashed',
        detail: 'exited with code 3\ntraceback',
      });
    });

    test('an empty stderr tail leaves no trailing newline', () => {
      const outcome: ChildOutcome = { kind: 'exited', exitCode: 3, stderrTail: '' };
      expect(classifyVerdict(anEnding({ outcome }))).toEqual({
        kind: 'failed',
        reason: 'child_crashed',
        detail: 'exited with code 3',
      });
    });
  });
});
