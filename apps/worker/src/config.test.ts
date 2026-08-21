/** The relations in [`config.ts`](./config.ts), exercised: that the shipped defaults satisfy every
 * one of them, and that each is actually enforced rather than merely written down.
 */

import { describe, expect, test } from 'vitest';
import {
  createWorkerConfig,
  WORKER_DEFAULTS,
  WorkerConfigError,
  type WorkerDefaultableFields,
  type WorkerRequiredFields,
} from './config.ts';

const REQUIRED_FIELDS: WorkerRequiredFields = {
  workerId: 'worker-under-test',
  runRoot: '/tmp/worker-under-test',
  childCommand: { executable: 'python3', leadingArguments: ['-m', 'gbd_foodservice_insights'] },
};

function refusalFor(
  overrides: WorkerDefaultableFields,
  required: Partial<WorkerRequiredFields> = {},
): WorkerConfigError {
  try {
    createWorkerConfig({ ...REQUIRED_FIELDS, ...required }, overrides);
  } catch (error) {
    if (error instanceof WorkerConfigError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify({ ...overrides, ...required })} to be refused`);
}

/** Naming every field the relation is between is what stops a case passing on some unrelated
 * violation it happened to trip as well. */
function expectOnlyViolation(overrides: WorkerDefaultableFields, ...fields: readonly string[]) {
  const { violations } = refusalFor(overrides);
  expect(violations).toHaveLength(1);
  for (const field of fields) expect(violations.join('\n')).toContain(field);
}

describe('createWorkerConfig', () => {
  test('the shipped defaults satisfy every relation', () => {
    expect(createWorkerConfig(REQUIRED_FIELDS)).toEqual({ ...WORKER_DEFAULTS, ...REQUIRED_FIELDS });
  });

  test('an override applies', () => {
    expect(createWorkerConfig(REQUIRED_FIELDS, { maxConcurrentAttempts: 1 })).toEqual({
      ...WORKER_DEFAULTS,
      ...REQUIRED_FIELDS,
      maxConcurrentAttempts: 1,
    });
  });

  test('an absent override leaves the default alone rather than erasing it', () => {
    expect(createWorkerConfig(REQUIRED_FIELDS, { maxConcurrentAttempts: undefined })).toEqual({
      ...WORKER_DEFAULTS,
      ...REQUIRED_FIELDS,
    });
  });
});

describe('the values a configuration must supply', () => {
  const blanks: readonly [string, Partial<WorkerRequiredFields>][] = [
    ['workerId', { workerId: '   ' }],
    ['runRoot', { runRoot: '' }],
    ['childCommand.executable', { childCommand: { executable: '', leadingArguments: [] } }],
  ];

  test.each(blanks)('refuses a blank %s', (field, required) => {
    const { violations } = refusalFor({}, required);
    expect(violations).toEqual([expect.stringContaining(field)]);
  });

  const nonCounts: readonly [string, number][] = [
    ['zero', 0],
    ['fractional', 1.5],
  ];

  test.each(nonCounts)('refuses a %s duration or count', (_label, value) => {
    expectOnlyViolation({ drainGraceMs: value }, 'drainGraceMs');
  });
});

describe('the relations between the thresholds a parent enforces on its own child', () => {
  test('killAfterNoProgressMs must outlast the interval that samples it', () => {
    expectOnlyViolation(
      { killAfterNoProgressMs: WORKER_DEFAULTS.superviseIntervalMs },
      'killAfterNoProgressMs',
      'superviseIntervalMs',
    );
  });

  test('killAfterTotalRuntimeMs must leave the hung verdict reachable', () => {
    expectOnlyViolation(
      {
        killAfterTotalRuntimeMs:
          WORKER_DEFAULTS.killAfterNoProgressMs + WORKER_DEFAULTS.superviseIntervalMs - 1,
      },
      'killAfterTotalRuntimeMs',
      'killAfterNoProgressMs',
    );
  });
});
