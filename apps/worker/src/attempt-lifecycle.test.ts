/** Nothing here is mocked — see [`testing/fake-child.ts`](./testing/fake-child.ts) for why — and
 * nothing waits on the wall clock: a `Kill` is a value the test constructs directly, standing in
 * for the decision `supervise()` will make once the loop that reads a `Clock` lands.
 */

import { existsSync } from 'node:fs';
import { DATABASE, shutdown } from '@gbd/db/env';
import { deletePrefix, getObject } from '@gbd/storage';
import { BLOB_STORE, shutdown as shutdownStore } from '@gbd/storage/env';
import { afterAll, describe, expect, test } from 'vitest';
import {
  type AttemptDependencies,
  failClaimedAttempt,
  MissingInputFileError,
  readChildEnding,
  recordVerdict,
  settleAttempt,
  startAttempt,
} from './attempt-lifecycle.ts';
import { chartFileName, RESULT_FILE_NAMES } from './contract/layout.ts';
import type { AttemptFixture } from './testing/attempt-fixture.ts';
import { withAttemptFixture } from './testing/attempt-fixture.ts';
import {
  type FakeChildStep,
  fakeChildCommand,
  fakeResultFileContents,
} from './testing/fake-child.ts';
import type { Kill } from './verdict.ts';

afterAll(async () => {
  await shutdown();
  shutdownStore();
});

function aWorkerId(): string {
  return `test-worker-${crypto.randomUUID()}`;
}

function dependencies(
  fixture: AttemptFixture,
  workerId: string,
  steps: readonly FakeChildStep[],
): AttemptDependencies {
  return {
    db: DATABASE,
    store: BLOB_STORE,
    workerId,
    runRoot: fixture.runRoot,
    childCommand: fakeChildCommand(steps),
    killGraceMs: 2_000,
  };
}

async function readAttempt(attemptId: AttemptFixture['attemptId']) {
  return await DATABASE.selectFrom('analysisAttempt')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
}

async function readResultFiles(attemptId: AttemptFixture['attemptId']) {
  return await DATABASE.selectFrom('resultFile')
    .selectAll()
    .where('analysisAttemptId', '=', attemptId)
    .orderBy('kind')
    .execute();
}

function fileNameFor(row: { kind: string; chartKey: string | null }): string {
  return row.kind === 'chart'
    ? chartFileName(row.chartKey as string)
    : RESULT_FILE_NAMES[row.kind as 'pdf' | 'xlsx'];
}

describe('a successful attempt, end to end', () => {
  test('uploads every declared file and records the ai columns', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'progress', sequence: 1 },
        { step: 'result', charts: ['total_spend'] },
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

      const attempt = await readAttempt(fixture.attemptId);
      expect(attempt).toMatchObject({
        status: 'succeeded',
        aiModel: 'fake-model',
        aiInputTokens: 1_000,
        aiOutputTokens: 200,
        aiCostUsd: '1.2345',
      });
      expect(attempt.finishedAt).toBeInstanceOf(Date);

      const resultFiles = await readResultFiles(fixture.attemptId);
      expect(resultFiles).toHaveLength(3);
      for (const row of resultFiles) {
        const fileName = fileNameFor(row);
        const body = await getObject(BLOB_STORE, row.storageKey);
        expect(new TextDecoder().decode(body)).toBe(fakeResultFileContents(fileName));
      }
      expect(resultFiles.find((row) => row.kind === 'chart')?.chartKey).toBe('total_spend');
    });
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
      expect((await readAttempt(fixture.attemptId)).status).toBe('succeeded');
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

  test('a declared chart file missing writes no result_file rows and no objects', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'result', charts: ['total_spend'], withoutFiles: ['chart-total_spend.png'] },
        { step: 'exit', code: 0 },
      ];

      const { prepared, settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(existsSync(prepared.runDirectory)).toBe(false);
      const attempt = await readAttempt(fixture.attemptId);
      expect(attempt).toMatchObject({ status: 'failed', failureReason: 'contract_violation' });
      expect(attempt.failureDetail).toContain('chart-total_spend.png');
      expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
    });
  });

  test('exit 0 with no result.json', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'exit', code: 0 }];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'child_crashed',
      });
    });
  });

  test('an unrunnable executable is a spawn failure recorded as infrastructure', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const badDependencies: AttemptDependencies = {
        db: DATABASE,
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
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

      expect(await readAttempt(fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'infrastructure',
      });
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
        expect(await readAttempt(fixture.attemptId)).toMatchObject(expected);
        expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
      });
    });
  }
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
      expect(await readAttempt(fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'unknown',
        failureDetail: 'something unexpected',
      });
    });
  });
});
