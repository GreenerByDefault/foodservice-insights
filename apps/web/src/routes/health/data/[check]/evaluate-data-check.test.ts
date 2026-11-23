import { HOUR_MS, MINUTE_MS } from '@gbd/core';
import type { Database, DatabaseExecutor } from '@gbd/db';
import {
  DB_NOW,
  dbMsAgo,
  divideByZero,
  insertAnalysisAttempt,
  insertAppUser,
  withRollback,
} from '@gbd/db/testing';
import { sql, type Transaction } from 'kysely';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { database } from '#lib/server/db.js';
import { SERVER_LOGS } from '#lib/server/testing/logs.js';
import { _evaluateDataCheck } from './+server.ts';
import { DATA_CHECKS, type DataCheckName } from './checks.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every check counts across the whole table, and other test files commit rows to this database
 * concurrently, so a count is only stable inside one snapshot. */
async function withSnapshot<T>(fn: (transaction: Transaction<Database>) => Promise<T>): Promise<T> {
  return await withRollback(database(), async (transaction) => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(transaction);
    return await fn(transaction);
  });
}

/** How many rows `insert` added to `check`'s count. */
async function countAdded(
  check: DataCheckName,
  insert: (transaction: Transaction<Database>) => Promise<unknown>,
): Promise<number> {
  return await withSnapshot(async (transaction) => {
    const before = await DATA_CHECKS[check].measure(transaction);
    await insert(transaction);
    const after = await DATA_CHECKS[check].measure(transaction);
    return after.count - before.count;
  });
}

/** A finished attempt whose email the sweep has tried `sends` times without success. */
async function insertUnsentAttempt(
  transaction: DatabaseExecutor,
  overrides: { finishedAgoMs: number; sends?: number; withRequester?: boolean },
) {
  const requester = overrides.withRequester === false ? null : await insertAppUser(transaction);
  const finishedAt = dbMsAgo(overrides.finishedAgoMs);
  const attempt = await insertAnalysisAttempt(transaction, {
    status: 'succeeded',
    createdAt: finishedAt,
    finishedAt,
    requestedByUserId: requester?.id ?? null,
  });
  const sends = overrides.sends ?? 0;
  if (sends === 0) return attempt;
  return await transaction
    .updateTable('analysisAttempt')
    .set({
      notificationAttempts: sends,
      notificationClaimedAt: DB_NOW,
      notificationClaimedByWorkerId: 'test-worker',
    })
    .where('id', '=', attempt.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

describe('DATA_CHECKS', () => {
  describe('queue-wait', () => {
    test('counts an attempt pending over 30 minutes', async () => {
      const added = await countAdded('queue-wait', (transaction) =>
        insertAnalysisAttempt(transaction, { createdAt: dbMsAgo(31 * MINUTE_MS) }),
      );
      expect(added).toBe(1);
    });

    test.for([
      ['pending under 30 minutes', { createdAt: dbMsAgo(29 * MINUTE_MS) }],
      ['claimed', { status: 'processing', createdAt: dbMsAgo(31 * MINUTE_MS) }],
      ['canceled', { status: 'canceled', createdAt: dbMsAgo(31 * MINUTE_MS) }],
    ] as const)('ignores an attempt %s', async ([, overrides]) => {
      const added = await countAdded('queue-wait', (transaction) =>
        insertAnalysisAttempt(transaction, overrides),
      );
      expect(added).toBe(0);
    });

    test('ignores a deleted attempt, whose tombstone stays pending', async () => {
      const added = await countAdded('queue-wait', async (transaction) => {
        const attempt = await insertAnalysisAttempt(transaction, {
          createdAt: dbMsAgo(31 * MINUTE_MS),
        });
        await transaction.deleteFrom('analysisAttempt').where('id', '=', attempt.id).execute();
      });
      expect(added).toBe(0);
    });
  });

  describe('failed-attempts', () => {
    test('counts a failure of ours in the last hour', async () => {
      const added = await countAdded('failed-attempts', (transaction) =>
        insertAnalysisAttempt(transaction, {
          status: 'failed',
          failureReason: 'abandoned',
          createdAt: dbMsAgo(59 * MINUTE_MS),
          finishedAt: dbMsAgo(59 * MINUTE_MS),
        }),
      );
      expect(added).toBe(1);
    });

    test.for([
      ['over an hour ago', { failureReason: 'abandoned', finishedAgoMs: 61 * MINUTE_MS }],
      ['on unusable data', { failureReason: 'unusable_data', finishedAgoMs: 0 }],
    ] as const)('ignores a failure %s', async ([, { failureReason, finishedAgoMs }]) => {
      const added = await countAdded('failed-attempts', (transaction) =>
        insertAnalysisAttempt(transaction, {
          status: 'failed',
          failureReason,
          createdAt: dbMsAgo(finishedAgoMs),
          finishedAt: dbMsAgo(finishedAgoMs),
        }),
      );
      expect(added).toBe(0);
    });

    test('ignores a success', async () => {
      const added = await countAdded('failed-attempts', (transaction) =>
        insertAnalysisAttempt(transaction, { status: 'succeeded' }),
      );
      expect(added).toBe(0);
    });
  });

  describe('unreaped-attempts', () => {
    async function insertProcessing(transaction: DatabaseExecutor, claimedAgoMs: number) {
      const claimedAt = dbMsAgo(claimedAgoMs);
      return await insertAnalysisAttempt(transaction, {
        status: 'processing',
        createdAt: claimedAt,
        claimedAt,
      });
    }

    test('counts an attempt processing past the claimed ceiling and a sweep', async () => {
      const added = await countAdded('unreaped-attempts', (transaction) =>
        insertProcessing(transaction, 32 * MINUTE_MS),
      );
      expect(added).toBe(1);
    });

    test('ignores one the reaper still has time for', async () => {
      const added = await countAdded('unreaped-attempts', (transaction) =>
        insertProcessing(transaction, 30 * MINUTE_MS),
      );
      expect(added).toBe(0);
    });
  });

  describe('notifications-gave-up', () => {
    test('counts an email out of sends', async () => {
      const added = await countAdded('notifications-gave-up', (transaction) =>
        insertUnsentAttempt(transaction, { finishedAgoMs: 2 * HOUR_MS, sends: 5 }),
      );
      expect(added).toBe(1);
    });

    test.for([
      ['with sends left', { finishedAgoMs: 2 * HOUR_MS, sends: 4 }],
      ['past the window', { finishedAgoMs: 7 * HOUR_MS, sends: 5 }],
    ] as const)('ignores an email %s', async ([, overrides]) => {
      const added = await countAdded('notifications-gave-up', (transaction) =>
        insertUnsentAttempt(transaction, overrides),
      );
      expect(added).toBe(0);
    });

    test('ignores a sent email', async () => {
      const added = await countAdded('notifications-gave-up', (transaction) =>
        insertAnalysisAttempt(transaction, {
          status: 'succeeded',
          createdAt: dbMsAgo(2 * HOUR_MS),
          finishedAt: dbMsAgo(2 * HOUR_MS),
          notificationEmailSentAt: dbMsAgo(2 * HOUR_MS),
        }),
      );
      expect(added).toBe(0);
    });
  });

  describe('notifications-stuck', () => {
    test.for([
      ['never tried', { finishedAgoMs: 2 * HOUR_MS }],
      ['with sends left', { finishedAgoMs: 2 * HOUR_MS, sends: 4 }],
    ] as const)('counts an email unsent after an hour, %s', async ([, overrides]) => {
      const added = await countAdded('notifications-stuck', (transaction) =>
        insertUnsentAttempt(transaction, overrides),
      );
      expect(added).toBe(1);
    });

    test.for([
      ['under an hour old', { finishedAgoMs: 59 * MINUTE_MS }],
      ['out of sends', { finishedAgoMs: 2 * HOUR_MS, sends: 5 }],
      ['whose requester was deleted', { finishedAgoMs: 2 * HOUR_MS, withRequester: false }],
    ] as const)('ignores an email %s', async ([, overrides]) => {
      const added = await countAdded('notifications-stuck', (transaction) =>
        insertUnsentAttempt(transaction, overrides),
      );
      expect(added).toBe(0);
    });

    test('ignores an email about a deleted report', async () => {
      const added = await countAdded('notifications-stuck', async (transaction) => {
        const attempt = await insertUnsentAttempt(transaction, { finishedAgoMs: 2 * HOUR_MS });
        await transaction
          .updateTable('report')
          .set({ deletedAt: DB_NOW })
          .where('id', '=', attempt.reportId)
          .execute();
      });
      expect(added).toBe(0);
    });

    test('ignores a canceled attempt, which is owed no email', async () => {
      const added = await countAdded('notifications-stuck', async (transaction) => {
        const requester = await insertAppUser(transaction);
        await insertAnalysisAttempt(transaction, {
          status: 'canceled',
          createdAt: dbMsAgo(2 * HOUR_MS),
          finishedAt: dbMsAgo(2 * HOUR_MS),
          cancelRequestedAt: dbMsAgo(2 * HOUR_MS),
          requestedByUserId: requester.id,
        });
      });
      expect(added).toBe(0);
    });
  });

  describe('connections', () => {
    test("counts this test's connection, against 80% of max_connections", async () => {
      const { measurement, maxConnections } = await withRollback(
        database(),
        async (transaction) => {
          const { rows } = await sql<{
            maxConnections: number;
          }>`SELECT current_setting('max_connections')::integer AS max_connections`.execute(
            transaction,
          );
          return {
            measurement: await DATA_CHECKS.connections.measure(transaction),
            maxConnections: rows[0]?.maxConnections ?? Number.NaN,
          };
        },
      );

      expect(measurement.count).toBeGreaterThanOrEqual(1);
      expect(measurement.threshold).toBe(Math.floor(maxConnections * 0.8));
    });
  });
});

describe('_evaluateDataCheck', () => {
  const { firing } = DATA_CHECKS['queue-wait'];

  test('fires on a row its check counts', async () => {
    const report = await withSnapshot(async (transaction) => {
      await insertAnalysisAttempt(transaction, { createdAt: dbMsAgo(31 * MINUTE_MS) });
      return await _evaluateDataCheck(transaction, 'queue-wait');
    });

    expect(report).toEqual({
      check: 'queue-wait',
      status: 'firing',
      firing,
      count: expect.any(Number),
      threshold: 0,
    });
  });

  test.for([
    [0, 'ok'],
    [1, 'ok'],
    [2, 'firing'],
  ] as const)('with a count of %i over a threshold of 1, is %s', async ([count, status]) => {
    vi.spyOn(DATA_CHECKS['queue-wait'], 'measure').mockResolvedValue({ count, threshold: 1 });

    const report = await _evaluateDataCheck(database(), 'queue-wait');

    expect(report).toEqual({ check: 'queue-wait', status, firing, count, threshold: 1 });
  });

  test('answers error when its query fails, logging why', async () => {
    const report = await withRollback(database(), async (transaction) => {
      // Leaves the transaction aborted, so the check's own query fails too.
      await divideByZero(transaction).catch(() => {});
      return await _evaluateDataCheck(transaction, 'queue-wait');
    });

    expect(report).toEqual({ check: 'queue-wait', status: 'error', firing });
    expect(SERVER_LOGS.records).toEqual([
      expect.objectContaining({ level: 'error', check: 'queue-wait', msg: 'Data check failed' }),
    ]);
  });
});
