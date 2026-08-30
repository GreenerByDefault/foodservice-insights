/** The worker, driven through its own methods rather than its scheduler: every test calls
 * `claimAndStart()`, `direct()`, `reap()`, `notify()`, or `drain()` directly, and `run()` gets
 * one smoke test.
 *
 * Nothing here is mocked. The child is a real process spawned through the same `spawnChild`
 * production uses ([`testing/fake-child.ts`](./testing/fake-child.ts)), and a failing service is a
 * real service that fails — `breakableDatabase`, `breakableBlobStore`. Nothing re-tests
 * `attempt/directive.ts`'s rule table, `attempt/verdict.ts`'s precedence, `sweeps/converge.ts`'s
 * predicates, or `sweeps/notifications.ts`'s backoff; what is proved here is the wiring around
 * them.
 *
 * Two constraints on how a test may be written, both from [`worker.ts`](./worker.ts):
 *
 * - **A threshold test advances a `manualClock`; a drain test passes `SYSTEM_CLOCK`.** `drain()` is
 *   the one method that sleeps, so a test that did both would hang — a manual clock never reaches a
 *   deadline a real sleep is waiting for.
 * - **`withRollback` cannot be used at all**, since the worker reads through `WORKER_DATABASE`'s own pool.
 *   [`testing/attempt-fixture.ts`](./testing/attempt-fixture.ts) commits instead.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SECOND_MS } from '@gbd/core';
import { breakableDatabase, withBreakable } from '@gbd/db/testing';
import { breakableBlobStore } from '@gbd/storage/testing';
import { describe, expect, test } from 'vitest';
import { claimNextAttempt, markAttemptFailed } from './attempt/queue.ts';
import { readProgress } from './child/run-directory.ts';
import { runPath } from './contract/layout.ts';
import { WORKER_DATABASE } from './db.ts';
import { aWorkerId } from './testing/attempt-helpers.ts';
import { backdateAttemptTimeline } from './testing/attempt-timeline.ts';
import type { FakeChildStep } from './testing/fake-child.ts';
import { waitUntil } from './testing/wait-until.ts';
import {
  attemptRow,
  deleteInputObject,
  directUntil,
  HOLDING_STEPS,
  parkAtRecord,
  parkAtUpload,
  release,
  reportAt,
  requestCancel,
  restoreInputObject,
  resultFileRows,
  runDirectory,
  SUCCEEDING_ON_RELEASE_STEPS,
  startOne,
  statusIs,
  uploadedKeys,
  withWorker,
} from './testing/worker-harness.ts';

describe('claiming and capacity', () => {
  test('an empty queue is queue-empty, and consumes no slot', async () => {
    await withWorker({ overrides: { maxConcurrentAttempts: 1 } }, async (harness, fixture) => {
      expect(await harness.worker.claimAndStart()).toBe('queue-empty');

      // `run()` makes this call forever against an idle queue, so it has to leave nothing behind:
      // with a limit of one, an attempt seeded afterwards still starts.
      await fixture.seedAttempt();
      expect(await harness.worker.claimAndStart()).toBe('started');
    });
  });

  test('refuses at the limit, then claims again once a finished attempt frees its slot', async () => {
    await withWorker(
      { steps: HOLDING_STEPS, reports: 2, overrides: { maxConcurrentAttempts: 1 } },
      async (harness, fixture) => {
        const first = await startOne(harness);
        const second = await reportAt(harness, 1).seedAttempt();

        expect(await harness.worker.claimAndStart()).toBe('at-capacity');

        await release(fixture, first);
        // Polled rather than asserted once: the slot is freed a few microtasks after the verdict
        // lands, and an `at-capacity` poll has no side effect.
        await waitUntil(
          async () => (await harness.worker.claimAndStart()) === 'started',
          'the finished attempt frees its slot',
        );

        expect(await statusIs(first, 'succeeded')).toBe(true);
        expect((await attemptRow(second)).status).toBe('processing');
      },
    );
  });

  test('a parked verdict still occupies its slot', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        {
          steps: SUCCEEDING_ON_RELEASE_STEPS,
          store: store.service,
          reports: 2,
          overrides: { maxConcurrentAttempts: 1 },
        },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);
          await reportAt(harness, 1).seedAttempt();

          await parkAtUpload(fixture, store, attemptId);

          expect(await harness.worker.claimAndStart()).toBe('at-capacity');
          expect((await attemptRow(attemptId)).status).toBe('processing');
        },
      );
    });
  });

  test('refuses once a drain has begun', async () => {
    await withWorker({}, async (harness, fixture) => {
      const attemptId = await fixture.seedAttempt();
      await harness.worker.drain();

      expect(await harness.worker.claimAndStart()).toBe('draining');
      expect((await attemptRow(attemptId)).status).toBe('pending');
    });
  });

  test('records infrastructure and frees the slot when the input object is gone', async () => {
    await withWorker({ overrides: { maxConcurrentAttempts: 1 } }, async (harness, fixture) => {
      const attemptId = await fixture.seedAttempt();
      await deleteInputObject(fixture);

      expect(await harness.worker.claimAndStart()).toBe('start-failed');

      const row = await attemptRow(attemptId);
      expect(row.status).toBe('failed');
      expect(row.failureReason).toBe('infrastructure');
      expect(row.failureDetail).toContain(fixture.inputCsvStorageKey);

      // The slot is free: with a capacity of one, a second attempt still starts.
      await restoreInputObject(fixture);
      await fixture.seedAttempt();
      expect(await harness.worker.claimAndStart()).toBe('started');
    });
  });

  test('two workers over one queue claim disjoint attempts', async () => {
    await withWorker({ steps: HOLDING_STEPS, reports: 2 }, async (first) => {
      const second = first.anotherWorker({ steps: HOLDING_STEPS });
      await reportAt(first, 0).seedAttempt();
      await reportAt(first, 1).seedAttempt();

      const outcomes = await Promise.all([
        first.worker.claimAndStart(),
        second.worker.claimAndStart(),
      ]);

      expect(outcomes).toEqual(['started', 'started']);
      const claimed = await WORKER_DATABASE.selectFrom('analysisAttempt')
        .select(['id', 'workerId'])
        .where(
          'reportId',
          'in',
          first.reports.map((report) => report.reportId),
        )
        .where('status', '=', 'processing')
        .execute();
      expect(claimed).toHaveLength(2);
      expect(new Set(claimed.map((row) => row.workerId))).toEqual(
        new Set([first.workerId, second.workerId]),
      );
    });
  });
});

describe('directing', () => {
  test('renews the lease on a child that is making progress', async () => {
    const steps: FakeChildStep[] = [
      { step: 'progress', sequence: 1 },
      { step: 'waitFor', sentinel: 'go' },
      { step: 'progress', sequence: 2 },
      { step: 'waitFor', sentinel: 'never' },
    ];
    await withWorker({ steps }, async (harness, fixture) => {
      const attemptId = await startOne(harness);
      await waitUntil(
        async () => (await readProgress(runDirectory(fixture, attemptId)))?.sequence === 1,
        'the child writes its first progress',
      );
      await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 5 * SECOND_MS });

      const claimed = (await attemptRow(attemptId)).leaseRenewedAt as Date;
      await harness.worker.direct();
      const afterFirstTick = (await attemptRow(attemptId)).leaseRenewedAt as Date;

      await release(fixture, attemptId);
      await waitUntil(
        async () => (await readProgress(runDirectory(fixture, attemptId)))?.sequence === 2,
        'the child writes its second progress',
      );
      await harness.worker.direct();
      const afterSecondTick = (await attemptRow(attemptId)).leaseRenewedAt as Date;

      expect(afterFirstTick.getTime()).toBeGreaterThan(claimed.getTime());
      expect(afterSecondTick.getTime()).toBeGreaterThan(afterFirstTick.getTime());
    });
  });

  test('a progress read that fails skips the renewal and leaves the child alone', async () => {
    const steps: FakeChildStep[] = [
      { step: 'waitFor', sentinel: 'go' },
      { step: 'progress', sequence: 1 },
      { step: 'waitFor', sentinel: 'never' },
    ];
    await withWorker({ steps }, async (harness, fixture) => {
      const attemptId = await startOne(harness);
      // A directory where `progress.json` belongs: EISDIR, a real read error rather than a mocked
      // one, and not the ENOENT of a child that has not written yet.
      const progress = runPath(runDirectory(fixture, attemptId), 'progress');
      await mkdir(progress);
      await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 5 * SECOND_MS });

      const before = (await attemptRow(attemptId)).leaseRenewedAt as Date;
      await harness.worker.direct();
      expect((await attemptRow(attemptId)).leaseRenewedAt).toEqual(before);

      // The child is still alive, which is what "does not kill" means: it runs on once the read
      // is possible again.
      await rm(progress, { recursive: true });
      await release(fixture, attemptId);
      await waitUntil(
        async () => (await readProgress(runDirectory(fixture, attemptId)))?.sequence === 1,
        'the child runs on past the failed read',
      );
    });
  });

  test('a malformed progress.json is a contract violation and kills the child', async () => {
    const steps: FakeChildStep[] = [
      { step: 'writeRaw', entry: 'progress', contents: '{ not json' },
      { step: 'waitFor', sentinel: 'never' },
    ];
    await withWorker({ steps }, async (harness, fixture) => {
      const attemptId = await startOne(harness);
      await waitUntil(
        () => existsSync(runPath(runDirectory(fixture, attemptId), 'progress')),
        'the child writes its malformed progress',
      );

      await harness.worker.direct();
      await waitUntil(() => statusIs(attemptId, 'failed'), 'the attempt is failed');

      expect((await attemptRow(attemptId)).failureReason).toBe('contract_violation');
    });
  });

  test('no progress within killAfterNoProgressMs is hung', async () => {
    await withWorker({ steps: [{ step: 'waitFor', sentinel: 'never' }] }, async (harness) => {
      const attemptId = await startOne(harness);

      harness.advance(harness.config.killAfterNoProgressMs);
      await harness.worker.direct();

      await waitUntil(() => statusIs(attemptId, 'failed'), 'the attempt is failed');
      expect((await attemptRow(attemptId)).failureReason).toBe('hung');
    });
  });

  test('running past killAfterTotalRuntimeMs is a hard timeout, however healthy it looks', async () => {
    const steps: FakeChildStep[] = [
      { step: 'progress', sequence: 1 },
      { step: 'waitFor', sentinel: 'go' },
      { step: 'progress', sequence: 2 },
      { step: 'waitFor', sentinel: 'never' },
    ];
    // The two thresholds are independent, so the ceiling can be reached with progress still
    // flowing — the only way it ever fires before `hung` would.
    const overrides = { killAfterTotalRuntimeMs: 60 * SECOND_MS + 50 };
    await withWorker({ steps, overrides }, async (harness, fixture) => {
      const attemptId = await startOne(harness);
      const directory = runDirectory(fixture, attemptId);
      await waitUntil(
        async () => (await readProgress(directory))?.sequence === 1,
        'the child writes its first progress',
      );

      harness.advance(60 * SECOND_MS);
      await release(fixture, attemptId);
      await waitUntil(
        async () => (await readProgress(directory))?.sequence === 2,
        'the child writes its second progress',
      );
      // Fresh progress this tick, so `hung` cannot fire on any later one.
      await harness.worker.direct();
      expect(await statusIs(attemptId, 'processing')).toBe(true);

      harness.advance(50);
      await harness.worker.direct();

      await waitUntil(() => statusIs(attemptId, 'failed'), 'the attempt is failed');
      expect((await attemptRow(attemptId)).failureReason).toBe('hard_timeout');
    });
  });

  test('a lease it can no longer renew fences the parent, and writes nothing', async () => {
    await withBreakable(breakableDatabase, async (database) => {
      await withWorker(
        {
          steps: [{ step: 'waitFor', sentinel: 'never' }],
          db: database.service,
          // Both kill thresholds pushed past the lease expiry, so fencing is what fires.
          overrides: {
            killAfterNoProgressMs: 200 * SECOND_MS,
            killAfterTotalRuntimeMs: 300 * SECOND_MS,
          },
        },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          database.break();
          harness.advance(harness.config.leaseExpiresAfterMs);
          await harness.worker.direct();

          await waitUntil(
            () => !existsSync(runDirectory(fixture, attemptId)),
            'the fenced child dies and its settle finds nothing to write',
          );
          database.restore();

          // Still `processing`: an attempt we may no longer own is one we write nothing for, and
          // another worker's reaper is what converges the row.
          const row = await attemptRow(attemptId);
          expect(row.status).toBe('processing');
          expect(row.finishedAt).toBeNull();
        },
      );
    });
  });
});

describe('cancellation, through the loop', () => {
  test('a cancel request on our own attempt kills the child and records canceled', async () => {
    await withWorker(
      { steps: [{ step: 'waitFor', sentinel: 'never' }] },
      async (harness, fixture) => {
        const attemptId = await startOne(harness);
        await requestCancel(attemptId);

        await harness.worker.direct();
        // This child never exits on its own, so the run directory going away is the kill landing.
        await waitUntil(
          () => !existsSync(runDirectory(fixture, attemptId)),
          'the killed child dies and its settle removes the run directory',
        );
        await waitUntil(() => statusIs(attemptId, 'canceled'), 'the attempt is canceled');

        const row = await attemptRow(attemptId);
        expect(row.failureReason).toBeNull();
        expect(row.finishedAt).toBeInstanceOf(Date);
        // A canceled attempt is never emailed about.
        expect(row.notificationEmailSentAt).toBeNull();
      },
    );
  });

  test('the same request converged by another worker leaves the owner nothing to write', async () => {
    await withWorker(
      { steps: [{ step: 'waitFor', sentinel: 'never' }] },
      async (harness, fixture) => {
        const other = harness.anotherWorker();
        const attemptId = await startOne(harness);
        await requestCancel(attemptId);
        await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 70 * SECOND_MS });

        expect(await other.worker.reap()).toEqual({ expired: [attemptId], canceled: [] });
        const reaped = await attemptRow(attemptId);
        expect(reaped.status).toBe('canceled');
        expect(reaped.failureReason).toBeNull();
        expect(reaped.reapedByWorkerId).toBe(other.workerId);

        // The owner still kills its child, and its own tick writes nothing.
        await harness.worker.direct();
        await waitUntil(
          () => !existsSync(runDirectory(fixture, attemptId)),
          'the owner kills the child it no longer owns',
        );
        expect(await attemptRow(attemptId)).toEqual(reaped);
      },
    );
  });

  test('reap converges a canceled pending attempt this worker never claimed', async () => {
    await withWorker({}, async (harness, fixture) => {
      const attemptId = await fixture.seedAttempt();
      await requestCancel(attemptId);

      expect(await harness.worker.reap()).toEqual({ expired: [], canceled: [attemptId] });
      expect((await attemptRow(attemptId)).status).toBe('canceled');
    });
  });
});

describe('parked verdicts', () => {
  test('a verdict parked at record lands once the database comes back', async () => {
    await withBreakable(breakableDatabase, async (database) => {
      await withWorker(
        { steps: SUCCEEDING_ON_RELEASE_STEPS, db: database.service },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          // Broken across the terminal write only: the upload happens against a healthy store, so
          // the verdict parks at `record` with its files already stored.
          await parkAtRecord(fixture, database, attemptId);
          expect(await statusIs(attemptId, 'processing')).toBe(true);

          database.restore();
          await directUntil(
            harness.worker,
            () => statusIs(attemptId, 'succeeded'),
            'the parked verdict lands',
          );
          expect(await resultFileRows(attemptId)).toHaveLength(2);
        },
      );
    });
  });

  test('a verdict parked at upload lands once the store comes back, renewing throughout', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        { steps: SUCCEEDING_ON_RELEASE_STEPS, store: store.service },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);
          await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 5 * SECOND_MS });

          await parkAtUpload(fixture, store, attemptId);
          const parked = (await attemptRow(attemptId)).leaseRenewedAt as Date;

          // The database is healthy throughout, so a parked record keeps its lease renewed — which
          // is why this stage needs `uploadRetryBudgetMs` and cannot rely on fencing.
          await harness.worker.direct();
          const renewed = (await attemptRow(attemptId)).leaseRenewedAt as Date;
          expect(renewed.getTime()).toBeGreaterThan(parked.getTime());

          store.restore();
          await directUntil(
            harness.worker,
            () => statusIs(attemptId, 'succeeded'),
            'the parked verdict lands',
          );

          const files = await resultFileRows(attemptId);
          expect(files).toHaveLength(2);
          expect(await uploadedKeys(fixture)).toHaveLength(files.length);
        },
      );
    });
  });

  test('a verdict parked at upload past its budget fails with the store error it parked on', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        { steps: SUCCEEDING_ON_RELEASE_STEPS, store: store.service },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          await parkAtUpload(fixture, store, attemptId);

          harness.advance(harness.config.uploadRetryBudgetMs);
          await directUntil(
            harness.worker,
            () => statusIs(attemptId, 'failed'),
            'the budget runs out and the verdict is converted',
          );

          const row = await attemptRow(attemptId);
          expect(row.failureReason).toBe('infrastructure');
          expect(row.failureDetail).toContain('blob store');
          expect(await resultFileRows(attemptId)).toHaveLength(0);
          expect(await uploadedKeys(fixture)).toEqual([]);
        },
      );
    });
  });

  test('a verdict that parks again spends the original budget, not a restarted one', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        { steps: SUCCEEDING_ON_RELEASE_STEPS, store: store.service },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          await parkAtUpload(fixture, store, attemptId);

          // Half the budget, a tick that re-parks against the still-broken store, then the other
          // half. A `since` restarted on the second park would put the budget permanently out of
          // reach, and the conversion below would never come.
          const halfTheBudget = harness.config.uploadRetryBudgetMs / 2;
          harness.advance(halfTheBudget);
          await harness.worker.direct();
          expect(await statusIs(attemptId, 'processing')).toBe(true);

          harness.advance(halfTheBudget);
          await directUntil(
            harness.worker,
            () => statusIs(attemptId, 'failed'),
            'the original budget runs out and the verdict is converted',
          );
        },
      );
    });
  });

  test('a reap mid-park drops the verdict without uploading at all', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        {
          steps: SUCCEEDING_ON_RELEASE_STEPS,
          store: store.service,
          overrides: { maxConcurrentAttempts: 1 },
        },
        async (harness, fixture) => {
          const other = harness.anotherWorker();
          const attemptId = await startOne(harness);

          await parkAtUpload(fixture, store, attemptId);

          await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 70 * SECOND_MS });
          expect((await other.worker.reap()).expired).toEqual([attemptId]);

          // Restored first, so what stops the upload is the drop and not the outage.
          store.restore();
          await harness.worker.direct();

          expect((await attemptRow(attemptId)).failureReason).toBe('abandoned');
          expect(await resultFileRows(attemptId)).toHaveLength(0);
          expect(await uploadedKeys(fixture)).toEqual([]);
          // Dropping the record is what frees the slot and stops the lease being renewed.
          await fixture.seedAttempt();
          expect(await harness.worker.claimAndStart()).toBe('started');
        },
      );
    });
  });

  test('a cancel mid-park records canceled with the budget unspent', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        { steps: SUCCEEDING_ON_RELEASE_STEPS, store: store.service },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          await parkAtUpload(fixture, store, attemptId);

          await requestCancel(attemptId);
          // Restored, so an unconverted resume would happily upload a report the user just deleted.
          store.restore();
          await directUntil(
            harness.worker,
            () => statusIs(attemptId, 'canceled'),
            'the parked verdict is converted to canceled',
          );

          expect((await attemptRow(attemptId)).failureReason).toBeNull();
          expect(await resultFileRows(attemptId)).toHaveLength(0);
          expect(await uploadedKeys(fixture)).toEqual([]);
        },
      );
    });
  });
});

describe('draining', () => {
  test('every in-flight attempt settles before drain resolves', async () => {
    await withWorker(
      {
        steps: HOLDING_STEPS,
        systemClock: true,
        reports: 2,
        overrides: { drainGraceMs: 5 * SECOND_MS },
      },
      async (harness, fixture) => {
        const first = await startOne(harness);
        const second = await startOne(harness, 1);

        const draining = harness.worker.drain();
        expect(await harness.worker.claimAndStart()).toBe('draining');
        await release(fixture, first);
        await release(fixture, second);
        await draining;

        expect(await statusIs(first, 'succeeded')).toBe(true);
        expect(await statusIs(second, 'succeeded')).toBe(true);
      },
    );
  });

  test('a child that ignores SIGTERM is killed at the deadline and recorded shut_down', async () => {
    await withWorker(
      {
        steps: [{ step: 'ignoreSigterm' }, { step: 'hang' }],
        systemClock: true,
        overrides: { drainGraceMs: 300 },
      },
      async (harness) => {
        const attemptId = await startOne(harness);

        await harness.worker.drain();

        const row = await attemptRow(attemptId);
        expect(row.status).toBe('failed');
        expect(row.failureReason).toBe('shut_down');
      },
    );
  });

  test('a verdict still parked at upload at the deadline is failed rather than abandoned', async () => {
    await withBreakable(breakableBlobStore, async (store) => {
      await withWorker(
        {
          steps: SUCCEEDING_ON_RELEASE_STEPS,
          store: store.service,
          systemClock: true,
          overrides: { drainGraceMs: 300 },
        },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          await parkAtUpload(fixture, store, attemptId);

          await harness.worker.drain();

          const row = await attemptRow(attemptId);
          expect(row.status).toBe('failed');
          expect(row.failureReason).toBe('infrastructure');
        },
      );
    });
  });

  test('a verdict still parked at record at the deadline is abandoned to the reaper', async () => {
    await withBreakable(breakableDatabase, async (database) => {
      await withWorker(
        {
          steps: SUCCEEDING_ON_RELEASE_STEPS,
          db: database.service,
          systemClock: true,
          overrides: { drainGraceMs: 300 },
        },
        async (harness, fixture) => {
          const attemptId = await startOne(harness);

          await parkAtRecord(fixture, database, attemptId);

          // Unlike an `upload` park, this one has nothing to convert to: the drain's last resume
          // goes to the same database that is still down. So the row is left `processing` for
          // another worker's reaper, which is `reaper-is-the-backstop` in `failures.ts`.
          await harness.worker.drain();
          database.restore();

          const row = await attemptRow(attemptId);
          expect(row.status).toBe('processing');
          expect(row.finishedAt).toBeNull();
          // The store was healthy throughout, so the files did land — which is what makes this a
          // `record` park rather than the `upload` one the test above covers.
          expect(await uploadedKeys(fixture)).toHaveLength(2);
          expect(await resultFileRows(attemptId)).toHaveLength(0);
        },
      );
    });
  });

  test('leases keep being renewed through a long drain', async () => {
    await withWorker(
      {
        steps: HOLDING_STEPS,
        systemClock: true,
        overrides: { drainGraceMs: 10 * SECOND_MS, directIntervalMs: 50 },
      },
      async (harness, fixture) => {
        const attemptId = await startOne(harness);
        await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 5 * SECOND_MS });

        const draining = harness.worker.drain();
        // A drain that stopped ticking `direct()` would have the rest of the fleet reap this
        // worker's own healthy attempts.
        const renewals = new Set<number>();
        await waitUntil(async () => {
          renewals.add(((await attemptRow(attemptId)).leaseRenewedAt as Date).getTime());
          return renewals.size > 2;
        }, 'the lease is renewed more than once during the drain');

        await release(fixture, attemptId);
        await draining;
        expect(await statusIs(attemptId, 'succeeded')).toBe(true);
      },
    );
  });
});

describe('the sweeps, wired up', () => {
  test("reap converges another worker's expired attempt under our own id", async () => {
    await withWorker({}, async (harness, fixture) => {
      const attemptId = await fixture.seedAttempt();
      await claimNextAttempt(WORKER_DATABASE, aWorkerId(), {
        candidateReports: [fixture.reportId],
      });
      await backdateAttemptTimeline(WORKER_DATABASE, attemptId, { renewedAgo: 70 * SECOND_MS });

      expect(await harness.worker.reap()).toEqual({ expired: [attemptId], canceled: [] });

      const row = await attemptRow(attemptId);
      expect(row.failureReason).toBe('abandoned');
      expect(row.reapedByWorkerId).toBe(harness.workerId);
    });
  });

  test('notify sends one email per terminal attempt and never a second', async () => {
    await withWorker({}, async (harness, fixture) => {
      const attemptId = await fixture.seedAttempt();
      await claimNextAttempt(WORKER_DATABASE, harness.workerId, {
        candidateReports: [fixture.reportId],
      });
      await markAttemptFailed(WORKER_DATABASE, attemptId, harness.workerId, {
        reason: 'infrastructure',
        detail: 'something unreachable',
      });

      expect(await harness.worker.notify()).toEqual([attemptId]);
      expect(harness.emails.sent()).toHaveLength(1);
      expect(harness.emails.sent()[0]?.to).toBe(fixture.requester.email);
      expect((await attemptRow(attemptId)).notificationEmailSentAt).toBeInstanceOf(Date);

      expect(await harness.worker.notify()).toEqual([]);
      expect(harness.emails.sent()).toHaveLength(1);
    });
  });
});

describe('run', () => {
  test('carries two seeded attempts all the way to a sent email, then drains', async () => {
    await withWorker({ systemClock: true, reports: 2 }, async (harness) => {
      const first = await reportAt(harness, 0).seedAttempt();
      const second = await reportAt(harness, 1).seedAttempt();

      const running = harness.worker.run();
      await waitUntil(
        async () =>
          (await statusIs(first, 'succeeded')) &&
          (await statusIs(second, 'succeeded')) &&
          harness.emails.sent().length === 2,
        'both attempts succeed and both emails are sent',
      );

      await harness.worker.drain();
      await expect(running).resolves.toBeUndefined();
    });
  });

  test('a database it cannot reach costs the poll, not the run', async () => {
    await withBreakable(breakableDatabase, async (database) => {
      await withWorker(
        { db: database.service, systemClock: true, overrides: { drainGraceMs: 300 } },
        async (harness, fixture) => {
          database.break();
          const attemptId = await fixture.seedAttempt();

          let ended = false;
          const running = harness.worker.run().finally(() => {
            ended = true;
          });

          // `absorb-or-fail`: many polls' worth of a database that is not answering, absorbed
          // rather than unwound into `run()`'s drain — which would have failed every attempt this
          // worker was already holding over an outage that said nothing about them.
          await delay(20 * harness.config.queuePollIntervalMs);
          expect(ended).toBe(false);
          expect(await statusIs(attemptId, 'pending')).toBe(true);

          database.restore();
          await waitUntil(
            () => statusIs(attemptId, 'succeeded'),
            'the attempt is claimed and succeeds once the database is back',
          );
          await harness.worker.drain();
          await expect(running).resolves.toBeUndefined();
        },
      );
    });
  });

  test('a claim Postgres refuses ends the run, drained', async () => {
    await withWorker(
      // Every statement this worker issues names a schema that is not there, so the claim comes
      // back as a refusal rather than an outage — the one claim failure ticking cannot fix.
      {
        db: WORKER_DATABASE.withSchema('no_such_schema'),
        systemClock: true,
        overrides: { drainGraceMs: 300 },
      },
      async (harness) => {
        await expect(harness.worker.run()).rejects.toThrow();
        // Reached its `finally`, so the drain ran rather than being skipped by the throw.
        expect(await harness.worker.claimAndStart()).toBe('draining');
      },
    );
  });
});
