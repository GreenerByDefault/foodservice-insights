/** A child is never mocked — see [`testing/fake-child.ts`](../testing/fake-child.ts) for why — and
 * nothing waits on the wall clock: a `Kill` is a value the test constructs directly, standing in
 * for the decision `direct()` makes from its own `Clock` loop. Where a store
 * or a database has to fail and come back, it is a real client that genuinely can
 * (`breakableBlobStore` from `@gbd/storage/testing`, `breakableDatabase` from `@gbd/db/testing`).
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { type Breakable, breakableDatabase, readAnalysisAttemptRow } from '@gbd/db/testing';
import { deletePrefix, getObject, putObject } from '@gbd/storage';
import { BLOB_STORE } from '@gbd/storage/env';
import { breakableBlobStore } from '@gbd/storage/testing';
import { describe, expect, test } from 'vitest';
import { RESULT_FILE_NAMES, resultFilePath } from '../contract/layout.ts';
import { WORKER_DATABASE } from '../db.ts';
import type { AttemptFixture } from '../testing/attempt-fixture.ts';
import { withAttemptFixture } from '../testing/attempt-fixture.ts';
import { aWorkerId } from '../testing/attempt-helpers.ts';
import {
  type FakeChildStep,
  fakeChildCommand,
  fakeResultFileContents,
} from '../testing/fake-child.ts';
import {
  type AttemptDependencies,
  CorruptInputFileError,
  deliverVerdict,
  failClaimedAttempt,
  MissingInputFileError,
  type PendingVerdict,
  type PreparedAttempt,
  type ReadEnding,
  readChildEnding,
  recordVerdict,
  settleAttempt,
  startAttempt,
} from './lifecycle.ts';
import { markAttemptFailed } from './queue.ts';
import type { Kill } from './verdict.ts';

function dependencies(
  fixture: AttemptFixture,
  workerId: string,
  steps: readonly FakeChildStep[],
): AttemptDependencies {
  return {
    db: WORKER_DATABASE,
    store: BLOB_STORE,
    workerId,
    runRoot: fixture.runRoot,
    childCommand: fakeChildCommand(steps),
    killGraceMs: 2_000,
  };
}

async function readResultFiles(attemptId: AttemptFixture['attemptId']) {
  return await WORKER_DATABASE.selectFrom('resultFile')
    .selectAll()
    .where('analysisAttemptId', '=', attemptId)
    .orderBy('kind')
    .execute();
}

function fileNameFor(row: { kind: 'pdf' | 'xlsx' }): string {
  return RESULT_FILE_NAMES[row.kind];
}

describe('a successful attempt, end to end', () => {
  test('uploads every declared file and records the ai columns', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'progress', sequence: 1 },
        { step: 'result' },
        { step: 'exit', code: 0 },
      ];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome);
      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(existsSync(prepared.runDirectory)).toBe(false);

      const attempt = await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId);
      expect(attempt.status).toBe('succeeded');
      expect(attempt.finishedAt).toBeInstanceOf(Date);

      const resultFiles = await readResultFiles(fixture.attemptId);
      expect(resultFiles).toHaveLength(2);
      for (const row of resultFiles) {
        const fileName = fileNameFor(row);
        const body = await getObject(BLOB_STORE, row.storageKey);
        expect(new TextDecoder().decode(body)).toBe(fakeResultFileContents(fileName));
      }
    });
  });
});

/** The shape shared by every "parks instead of losing the verdict" test below, whichever
 * dependency turned out to be unreachable: break it, settle against it, land on `stage`, restore
 * it, then resume and land on `recorded`.
 *
 * `dependencies` carries the same `breakable.service` throughout — recovery is that one
 * handle coming back, not a second object standing in for it.
 */
async function expectParkThenResume(
  fixture: AttemptFixture,
  dependencies: AttemptDependencies,
  breakable: Pick<Breakable<unknown>, 'break' | 'restore'>,
  prepared: PreparedAttempt,
  ending: ReadEnding,
  stage: PendingVerdict['stage'],
): Promise<void> {
  breakable.break();
  const parked = await settleAttempt(dependencies, prepared, ending);

  expect(parked).toMatchObject({ kind: 'parked', pending: { stage } });
  if (stage === 'upload' && parked.kind === 'parked' && parked.pending.stage === 'upload') {
    expect(parked.pending.lastError).toBeDefined();
  }
  expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
    'processing',
  );
  expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
  // The bytes outlive the run directory, which is what makes the resume below possible.
  expect(existsSync(prepared.runDirectory)).toBe(false);

  if (parked.kind !== 'parked') throw new Error('expected a parked verdict');
  breakable.restore();
  const resumed = await deliverVerdict(dependencies, prepared, parked.pending);

  expect(resumed).toEqual({ kind: 'recorded' });
  expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
    'succeeded',
  );
  const resultFiles = await readResultFiles(fixture.attemptId);
  expect(resultFiles).toHaveLength(2);
  for (const row of resultFiles) {
    const body = await getObject(BLOB_STORE, row.storageKey);
    expect(new TextDecoder().decode(body)).toBe(fakeResultFileContents(fileNameFor(row)));
  }
}

describe('a blob store that cannot be reached', () => {
  test('parks the verdict at the upload stage, and a resume lands it once the store is back', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableBlobStore();
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];
        const working = dependencies(fixture, workerId, steps);
        const withBreakableStore = { ...working, store: breakable.service };

        const prepared = await startAttempt(working, fixture.attemptId);
        const ending = await readChildEnding(prepared, await prepared.child.exited);

        await expectParkThenResume(
          fixture,
          withBreakableStore,
          breakable,
          prepared,
          ending,
          'upload',
        );
      });
    } finally {
      await breakable.close();
    }
  });

  test('does not park a verdict that has nothing to upload', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableBlobStore();
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'failure', reason: 'upstream_api', detail: 'the AI provider returned a 503' },
          { step: 'exit', code: 1 },
        ];
        const working = dependencies(fixture, workerId, steps);
        const withBreakableStore = { ...working, store: breakable.service };

        const prepared = await startAttempt(working, fixture.attemptId);
        const ending = await readChildEnding(prepared, await prepared.child.exited);
        breakable.break();
        const settled = await settleAttempt(withBreakableStore, prepared, ending);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'upstream_api',
        });
      });
    } finally {
      await breakable.close();
    }
  });
});

describe('a database that cannot be reached', () => {
  test('parks the verdict at the record stage, and a resume lands it once the database is back', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableDatabase();
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];
        const working = dependencies(fixture, workerId, steps);
        const withBreakableDb = { ...working, db: breakable.service };

        const prepared = await startAttempt(working, fixture.attemptId);
        const ending = await readChildEnding(prepared, await prepared.child.exited);

        // The store is fine, so the upload stage clears; only the guarded write is left, and
        // that's what breaking the database parks.
        await expectParkThenResume(fixture, withBreakableDb, breakable, prepared, ending, 'record');
      });
    } finally {
      await breakable.close();
    }
  });
});

describe('a hung child that finished first', () => {
  test('is recorded succeeded, not hung', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome, { reason: 'hung' });
      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      expect(settled).toEqual({ kind: 'recorded' });
      expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
        'succeeded',
      );
    });
  });
});

describe('failure rows', () => {
  async function runAndSettle(
    fixture: AttemptFixture,
    workerId: string,
    steps: readonly FakeChildStep[],
    kill?: Kill,
  ) {
    const prepared = await startAttempt(dependencies(fixture, workerId, steps), fixture.attemptId);
    const outcome = await prepared.child.exited;
    const ending = await readChildEnding(prepared, outcome, kill);
    return {
      prepared,
      settled: await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending),
    };
  }

  test('a declared file missing writes no result_file rows and no objects', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'result', withoutFiles: ['report.xlsx'] },
        { step: 'exit', code: 0 },
      ];

      const { prepared, settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(existsSync(prepared.runDirectory)).toBe(false);
      const attempt = await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId);
      expect(attempt).toMatchObject({ status: 'failed', failureReason: 'contract_violation' });
      expect(attempt.failureDetail).toContain('report.xlsx');
      expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
    });
  });

  test('exit 0 with no result.json', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'exit', code: 0 }];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'contract_violation',
      });
    });
  });

  test('a malformed result.json', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'writeRaw', entry: 'result', contents: 'not json' },
        { step: 'exit', code: 0 },
      ];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'contract_violation',
      });
    });
  });

  test('exit 1 with a failure.json records the reason the child gave', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'failure', reason: 'upstream_api', detail: 'the AI provider returned a 503' },
        { step: 'exit', code: 1 },
      ];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'upstream_api',
        failureDetail: 'the AI provider returned a 503',
      });
    });
  });

  test('exit 1 without a failure.json — an uncaught exception, not a document the child chose to skip', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'crash', message: 'ZeroDivisionError' }];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'contract_violation',
      });
    });
  });

  test('an unexpected exit code is child_crashed', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'exit', code: 3 }];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'child_crashed',
      });
    });
  });

  test('a result file that fails to read for a reason other than missing is infrastructure, not a silent miss', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'result', withoutFiles: ['report.pdf'] },
        { step: 'exit', code: 0 },
      ];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      // A directory where the child would have written report.pdf: readResultFiles must throw
      // EISDIR rather than treating it the same as a file the child simply never wrote.
      await mkdir(resultFilePath(prepared.runDirectory, 'report.pdf'));

      const ending = await readChildEnding(prepared, outcome);
      expect(ending.read).toMatchObject({ kind: 'read-error' });

      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'infrastructure',
      });
    });
  });

  test('an unrunnable executable is a spawn failure recorded as infrastructure', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const badDependencies: AttemptDependencies = {
        db: WORKER_DATABASE,
        store: BLOB_STORE,
        workerId,
        runRoot: fixture.runRoot,
        childCommand: { executable: `${fixture.runRoot}/not-a-program`, leadingArguments: [] },
        killGraceMs: 2_000,
      };

      const prepared = await startAttempt(badDependencies, fixture.attemptId);
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome);
      const settled = await settleAttempt(badDependencies, prepared, ending);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'infrastructure',
      });
    });
  });

  test('a missing input object fails the attempt without spawning a child', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      await deletePrefix(BLOB_STORE, fixture.inputCsvStorageKey);
      const attemptDependencies = dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]);

      const start = startAttempt(attemptDependencies, fixture.attemptId);
      await expect(start).rejects.toThrow(MissingInputFileError);

      await failClaimedAttempt(
        attemptDependencies,
        fixture.attemptId,
        await start.catch((error) => error),
      );

      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'infrastructure',
      });
    });
  });

  test('an input object the blob store served corrupt fails the attempt as infrastructure', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      // Truncated, not garbage: still valid CSV, so only the checksum and size catch it.
      await putObject(BLOB_STORE, fixture.inputCsvStorageKey, Buffer.from('filler'));
      const attemptDependencies = dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]);

      const start = startAttempt(attemptDependencies, fixture.attemptId);
      await expect(start).rejects.toThrow(CorruptInputFileError);

      await failClaimedAttempt(
        attemptDependencies,
        fixture.attemptId,
        await start.catch((error) => error),
      );

      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'infrastructure',
      });
    });
  });

  test('an input object of the right size but the wrong bytes is still rejected', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const sameLength = Buffer.alloc(fixture.inputCsv.byteLength, 0x61);
      await putObject(BLOB_STORE, fixture.inputCsvStorageKey, sameLength);

      await expect(
        startAttempt(
          dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
          fixture.attemptId,
        ),
      ).rejects.toThrow(CorruptInputFileError);
    });
  });

  test('a startAttempt that throws leaves no run directory behind', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      await deletePrefix(BLOB_STORE, fixture.inputCsvStorageKey);
      const runDirectory = `${fixture.runRoot}/${fixture.attemptId}`;

      await expect(
        startAttempt(
          dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
          fixture.attemptId,
        ),
      ).rejects.toThrow(MissingInputFileError);

      expect(existsSync(runDirectory)).toBe(false);
    });
  });
});

describe('kills', () => {
  const KILLS: readonly Kill[] = [
    { reason: 'hung' },
    { reason: 'hard-timeout' },
    { reason: 'shutting-down' },
    { reason: 'canceled' },
    { reason: 'fenced' },
    { reason: 'lost' },
    { reason: 'contract-violation', detail: 'progress.json: not valid JSON' },
  ];

  const EXPECTED: Record<Kill['reason'], { status: string; failureReason: string | null }> = {
    hung: { status: 'failed', failureReason: 'hung' },
    'hard-timeout': { status: 'failed', failureReason: 'hard_timeout' },
    'shutting-down': { status: 'failed', failureReason: 'shut_down' },
    canceled: { status: 'canceled', failureReason: null },
    fenced: { status: 'processing', failureReason: null },
    lost: { status: 'processing', failureReason: null },
    'contract-violation': { status: 'failed', failureReason: 'contract_violation' },
  };

  for (const kill of KILLS) {
    test(`${kill.reason} produces its verdict`, async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'waitFor', sentinel: 'go' },
          { step: 'exit', code: 0 },
        ];

        const prepared = await startAttempt(
          dependencies(fixture, workerId, steps),
          fixture.attemptId,
        );
        // `analysis_attempt_canceled_requires_request` needs a request behind the verdict this
        // kill is about to produce. In the real flow, `cancelRequestedAt` non-null is exactly
        // what would have led `direct()` to build this `Kill`.
        if (kill.reason === 'canceled') {
          await WORKER_DATABASE.updateTable('analysisAttempt')
            .set({ cancelRequestedAt: new Date() })
            .where('id', '=', fixture.attemptId)
            .execute();
        }
        prepared.child.kill();
        const outcome = await prepared.child.exited;
        const ending = await readChildEnding(prepared, outcome, kill);
        const settled = await settleAttempt(
          dependencies(fixture, workerId, steps),
          prepared,
          ending,
        );

        const expected = EXPECTED[kill.reason];
        if (expected.status === 'processing') {
          // fenced/lost write nothing: the attempt is left exactly as claimAndStart left it.
          expect(settled).toEqual({ kind: 'lost' });
        } else {
          expect(settled).toEqual({ kind: 'recorded' });
        }
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject(
          expected,
        );
        expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
      });
    });
  }
});

describe('losing the race to record a verdict', () => {
  test('a writer that finished the attempt first leaves settleAttempt lost, not recorded', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome);

      // Stand in for the reaper (or a retried call that already committed): the attempt is no
      // longer `processing`, so classifyVerdict's `succeeded` verdict can no longer be written —
      // exactly the case `kills`' fenced/lost tests don't reach, since those short-circuit to
      // `unowned` before settleAttempt ever tries a write.
      await markAttemptFailed(WORKER_DATABASE, fixture.attemptId, workerId, {
        reason: 'hard_timeout',
        detail: 'reaped before this settle ran',
      });

      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      expect(settled).toEqual({ kind: 'lost' });
      expect(existsSync(prepared.runDirectory)).toBe(false);
      // The reaper's write stands: settleAttempt did not overwrite it with the `succeeded` verdict
      // it computed.
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'hard_timeout',
      });
      // The guarded insert never ran, so no result_file rows exist even though the objects were
      // already uploaded.
      expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
    });
  });
});

describe('recordVerdict', () => {
  test('records a failure and returns whether we still owned the attempt', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const attemptDependencies = dependencies(fixture, workerId, []);

      const won = await recordVerdict(attemptDependencies, fixture.attemptId, {
        kind: 'failed',
        reason: 'unknown',
        detail: 'something unexpected',
      });

      expect(won).toBe(true);
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'unknown',
        failureDetail: 'something unexpected',
      });
    });
  });
});
