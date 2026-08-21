/** The relations in [`config.ts`](./config.ts), exercised: that the shipped defaults satisfy every
 * one of them, and that each is actually enforced rather than merely written down.
 */

import { describe, expect, test } from 'vitest';
import {
  createWorkerConfig,
  WORKER_DEFAULTS,
  WorkerConfigError,
  type WorkerEnvironment,
  type WorkerOverrides,
} from './config.ts';

const AN_ENVIRONMENT: WorkerEnvironment = {
  workerId: 'worker-under-test',
  runRoot: '/tmp/worker-under-test',
  childCommand: { executable: 'python3', leadingArguments: ['-m', 'gbd_foodservice_insights'] },
};

function refusalFor(
  overrides: WorkerOverrides,
  environment: Partial<WorkerEnvironment> = {},
): WorkerConfigError {
  try {
    createWorkerConfig({ ...AN_ENVIRONMENT, ...environment }, overrides);
  } catch (error) {
    if (error instanceof WorkerConfigError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify({ ...overrides, ...environment })} to be refused`);
}

/** Naming every field the relation is between is what stops a case passing on some unrelated
 * violation it happened to trip as well. */
function expectOnlyViolation(overrides: WorkerOverrides, ...fields: readonly string[]) {
  const { violations } = refusalFor(overrides);
  expect(violations).toHaveLength(1);
  for (const field of fields) expect(violations.join('\n')).toContain(field);
}

describe('createWorkerConfig', () => {
  test('the shipped defaults satisfy every relation', () => {
    expect(createWorkerConfig(AN_ENVIRONMENT)).toEqual({ ...WORKER_DEFAULTS, ...AN_ENVIRONMENT });
  });

  test('an override applies', () => {
    expect(createWorkerConfig(AN_ENVIRONMENT, { maxConcurrentAttempts: 1 })).toEqual({
      ...WORKER_DEFAULTS,
      ...AN_ENVIRONMENT,
      maxConcurrentAttempts: 1,
    });
  });

  test('an absent override leaves the default alone rather than erasing it', () => {
    expect(createWorkerConfig(AN_ENVIRONMENT, { maxConcurrentAttempts: undefined })).toEqual({
      ...WORKER_DEFAULTS,
      ...AN_ENVIRONMENT,
    });
  });
});

describe('the values a configuration must supply', () => {
  const blanks: readonly [string, Partial<WorkerEnvironment>][] = [
    ['workerId', { workerId: '   ' }],
    ['runRoot', { runRoot: '' }],
    ['childCommand.executable', { childCommand: { executable: '', leadingArguments: [] } }],
  ];

  test.each(blanks)('refuses a blank %s', (field, environment) => {
    const { violations } = refusalFor({}, environment);
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
