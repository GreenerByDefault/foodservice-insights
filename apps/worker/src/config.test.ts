/** The relations in [`config.ts`](./config.ts), exercised: that the shipped defaults satisfy every
 * one of them, and that each is actually enforced rather than merely written down.
 *
 * The last test reaches the database, because the one relation `createWorkerConfig` cannot decide
 * is whether `maxNotificationAttempts` still matches the literal baked into the
 * `analysis_attempt_notification_pending` index.
 */

import { DATABASE } from '@gbd/db/env';
import { sql } from 'kysely';
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

const SECOND_MS = 1_000;

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

  test('reports every broken relation at once, not just the first', () => {
    // One value breaks two: the longest send it could be retrying, and the outage span.
    const { violations } = refusalFor({ notificationRetryBaseMs: 10 * SECOND_MS });

    expect(violations).toEqual([
      expect.stringContaining('notificationRetryBaseMs'),
      expect.stringContaining('maxNotificationAttempts'),
    ]);
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
    expectOnlyViolation({ maxReapsPerSweep: value }, 'maxReapsPerSweep');
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

  test('leaseExpiresAfterMs must survive one slow renewal, so a healthy parent never fences itself', () => {
    expectOnlyViolation(
      { leaseExpiresAfterMs: 90 * SECOND_MS },
      'leaseExpiresAfterMs',
      'superviseIntervalMs',
    );
  });

  test('uploadRetryBudgetMs must buy more than two resumes', () => {
    expectOnlyViolation(
      { uploadRetryBudgetMs: 2 * WORKER_DEFAULTS.superviseIntervalMs },
      'uploadRetryBudgetMs',
      'superviseIntervalMs',
    );
  });
});

describe('the relations between a worker and the rest of the fleet', () => {
  test('claimedCeilingMs must outlast an attempt that runs, is killed, then parks on the blob store', () => {
    expectOnlyViolation(
      {
        claimedCeilingMs:
          WORKER_DEFAULTS.killAfterTotalRuntimeMs +
          WORKER_DEFAULTS.killGraceMs +
          WORKER_DEFAULTS.uploadRetryBudgetMs,
      },
      'claimedCeilingMs',
      'killAfterTotalRuntimeMs',
      'uploadRetryBudgetMs',
    );
  });

  test('reapIntervalMs must not outlast the expiry the sweep is looking for', () => {
    expectOnlyViolation(
      { reapIntervalMs: WORKER_DEFAULTS.leaseExpiresAfterMs + 1 },
      'reapIntervalMs',
      'leaseExpiresAfterMs',
    );
  });

  test('maxConcurrentAttempts must keep the worker inside the connection pool', () => {
    expectOnlyViolation(
      { maxConcurrentAttempts: WORKER_DEFAULTS.maxConcurrentAttempts + 1 },
      'maxConcurrentAttempts',
    );
  });
});

describe('the relations the notification sweep rests on', () => {
  test('notifyIntervalMs must stay under the latency users are promised', () => {
    expectOnlyViolation({ notifyIntervalMs: 30 * SECOND_MS }, 'notifyIntervalMs');
  });

  test('notificationRetryBaseMs must outlast the longest send it could be retrying', () => {
    // `maxNotificationAttempts` rises with it, so the outage relation below stays satisfied and
    // this case is left testing one relation rather than two.
    expectOnlyViolation(
      { notificationRetryBaseMs: 10 * SECOND_MS, maxNotificationAttempts: 10 },
      'notificationRetryBaseMs',
    );
  });

  test('the retries must span the longest outage they are meant to ride out', () => {
    expectOnlyViolation(
      { maxNotificationAttempts: WORKER_DEFAULTS.maxNotificationAttempts - 1 },
      'notificationRetryBaseMs',
      'maxNotificationAttempts',
    );
  });

  test('maxNotificationAttempts matches the literal in the notification index', async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'analysis_attempt_notification_pending'
    `.execute(DATABASE);

    expect(rows.map((row) => row.indexdef)).toEqual([
      expect.stringContaining(`notification_attempts < ${WORKER_DEFAULTS.maxNotificationAttempts}`),
    ]);
  });
});
