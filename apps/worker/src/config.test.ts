import { SEND_TIMEOUT_MS } from '@gbd/email';
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import {
  createWorkerConfig,
  EMAIL_LATENCY_TARGET_MS,
  MAX_RENEWAL_ROUND_TRIP_MS,
  WORKER_DEFAULTS,
  WorkerConfigError,
  type WorkerDefaultableFields,
  type WorkerRequiredFields,
} from './config.ts';
import { WORKER_DATABASE, WORKER_DB_LIMITS } from './db.ts';

const REQUIRED_FIELDS: WorkerRequiredFields = {
  workerId: 'worker-under-test',
  runRoot: '/tmp/worker-under-test',
  childCommand: { executable: 'python3', leadingArguments: ['-m', 'gbd_foodservice_insights'] },
};

function refusalFor(
  overrides: WorkerDefaultableFields,
  required: Partial<WorkerRequiredFields> = {},
  platformShutdownGraceMs?: number,
): WorkerConfigError {
  try {
    createWorkerConfig({ ...REQUIRED_FIELDS, ...required }, overrides, platformShutdownGraceMs);
  } catch (error) {
    if (error instanceof WorkerConfigError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify({ ...overrides, ...required })} to be refused`);
}

function expectOnlyViolation(overrides: WorkerDefaultableFields, ...fragments: readonly string[]) {
  const { violations } = refusalFor(overrides);
  expect(violations).toHaveLength(1);
  const [violation] = violations;
  for (const fragment of fragments) expect(violation).toContain(fragment);
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

  test('reports every broken relation at once, not just the first', () => {
    // At SEND_TIMEOUT_MS, this fails both to outlast the longest send (a strict `>`) and, at the
    // shipped maxNotificationAttempts, to span the outage the retries are meant to survive.
    const { violations } = refusalFor({ notificationRetryBaseMs: SEND_TIMEOUT_MS });
    expect(violations).toEqual([
      expect.stringContaining('notificationRetryBaseMs'),
      expect.stringContaining('maxNotificationAttempts'),
    ]);
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
    expectOnlyViolation(
      { maxReapsPerSweep: value },
      'maxReapsPerSweep must be a positive whole number',
    );
  });

  // The loop above skips this field because it is not a number, so it carries its own check.
  test.each(nonCounts)('refuses a %s retry wait', (_label, value) => {
    expectOnlyViolation(
      { transientRetryWaitsMs: [250, value] },
      'every transientRetryWaitsMs entry must be a positive whole number',
    );
  });

  test('accepts retrying without any wait at all', () => {
    expect(
      createWorkerConfig(REQUIRED_FIELDS, { transientRetryWaitsMs: [] }).transientRetryWaitsMs,
    ).toEqual([]);
  });
});

describe('the relations between the thresholds a parent enforces on its own child', () => {
  test('killAfterNoProgressMs must outlast the interval that samples it', () => {
    expectOnlyViolation(
      { killAfterNoProgressMs: WORKER_DEFAULTS.directIntervalMs },
      'killAfterNoProgressMs must exceed directIntervalMs',
    );
  });

  test('killAfterTotalRuntimeMs must leave the hung verdict reachable', () => {
    expectOnlyViolation(
      {
        killAfterTotalRuntimeMs:
          WORKER_DEFAULTS.killAfterNoProgressMs + WORKER_DEFAULTS.directIntervalMs - 1,
      },
      'killAfterTotalRuntimeMs must be at least killAfterNoProgressMs + directIntervalMs',
    );
  });

  test('leaseExpiresAfterMs must survive one slow renewal, so a healthy parent never fences itself', () => {
    // At the boundary itself: one renewal taking the longest a connection wait plus a statement
    // can take, followed by one more direct tick before the lease is checked again.
    const oneRenewalPlusOneTick =
      WORKER_DB_LIMITS.connectionTimeoutMs +
      WORKER_DB_LIMITS.statementTimeoutMs +
      WORKER_DEFAULTS.directIntervalMs;
    expectOnlyViolation(
      { leaseExpiresAfterMs: oneRenewalPlusOneTick },
      'leaseExpiresAfterMs must exceed one renewal round trip',
      'plus directIntervalMs',
    );
  });

  test('uploadRetryBudgetMs must buy more than two resumes', () => {
    expectOnlyViolation(
      { uploadRetryBudgetMs: 2 * WORKER_DEFAULTS.directIntervalMs },
      'uploadRetryBudgetMs must buy more than two resumes',
      '2 × directIntervalMs',
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
      'claimedCeilingMs must exceed the longest life of an attempt nothing is wrong with — ' +
        'killAfterTotalRuntimeMs running, then killGraceMs dying, then uploadRetryBudgetMs ' +
        'parked on the blob store',
    );
  });

  test('reapIntervalMs must not outlast the expiry the sweep is looking for', () => {
    expectOnlyViolation(
      { reapIntervalMs: WORKER_DEFAULTS.leaseExpiresAfterMs + 1 },
      'reapIntervalMs must not exceed leaseExpiresAfterMs',
    );
  });

  test('maxConcurrentAttempts must keep the worker inside the connection pool', () => {
    expectOnlyViolation(
      { maxConcurrentAttempts: WORKER_DEFAULTS.maxConcurrentAttempts + 1 },
      "maxConcurrentAttempts must keep the worker's concurrent database work inside the pool's",
    );
  });
});

describe("the relation against the hosting platform's own shutdown grace", () => {
  const drainPlusKillPlusWrite =
    WORKER_DEFAULTS.drainGraceMs + WORKER_DEFAULTS.killGraceMs + MAX_RENEWAL_ROUND_TRIP_MS;

  test('is skipped when the platform grace is not known', () => {
    expect(createWorkerConfig(REQUIRED_FIELDS)).toEqual({ ...WORKER_DEFAULTS, ...REQUIRED_FIELDS });
  });

  test('refuses a platform grace that does not outlast drainGraceMs + killGraceMs + one terminal write', () => {
    const { violations } = refusalFor({}, {}, drainPlusKillPlusWrite);
    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation).toContain('PLATFORM_SHUTDOWN_GRACE_MS');
    expect(violation).toContain('must exceed drainGraceMs + killGraceMs');
  });

  test('accepts a platform grace that leaves room for the terminal write after a kill', () => {
    expect(createWorkerConfig(REQUIRED_FIELDS, {}, drainPlusKillPlusWrite + 1)).toEqual({
      ...WORKER_DEFAULTS,
      ...REQUIRED_FIELDS,
    });
  });
});

describe('the relations the notification sweep rests on', () => {
  test('notifyIntervalMs must stay under the latency users are promised', () => {
    expectOnlyViolation(
      { notifyIntervalMs: EMAIL_LATENCY_TARGET_MS },
      `notifyIntervalMs must stay under the ${EMAIL_LATENCY_TARGET_MS}ms`,
    );
  });

  test('notificationRetryBaseMs must outlast the longest send it could be retrying', () => {
    // `maxNotificationAttempts` rises with it, so the outage relation below stays satisfied and
    // this case is left testing one relation rather than two.
    expectOnlyViolation(
      { notificationRetryBaseMs: SEND_TIMEOUT_MS, maxNotificationAttempts: 10 },
      'notificationRetryBaseMs must exceed',
      'the longest a send may run',
    );
  });

  test('the retries must span the longest outage they are meant to ride out', () => {
    expectOnlyViolation(
      { maxNotificationAttempts: WORKER_DEFAULTS.maxNotificationAttempts - 1 },
      'notificationRetryBaseMs and maxNotificationAttempts must together span at least',
    );
  });

  test('maxNotificationAttempts matches the literal in the notification index', async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'analysis_attempt_notification_pending'
    `.execute(WORKER_DATABASE);

    expect(rows.map((row) => row.indexdef)).toEqual([
      expect.stringContaining(`notification_attempts < ${WORKER_DEFAULTS.maxNotificationAttempts}`),
    ]);
  });
});
