/** One attempt, start to finish: load its inputs, spawn its child, read how the child ended, and
 * write the verdict. [`verdict.ts`](./verdict.ts) is the pure decision this file feeds and acts
 * on; [`worker.ts`](./worker.ts) (landing with the supervision loop) is what decides *when* to
 * call each of these and what to do with an in-flight record between calls.
 */

import type { DatabaseExecutor } from '@gbd/db';
import {
  type AnalysisAttemptId,
  newResultFileId,
  type OrganizationId,
  type ReportId,
  type ResultFileKind,
} from '@gbd/db';
import { type BlobStore, getObject, isBlobStoreError, putResultFile } from '@gbd/storage';
import { type ChildCommand, type ChildOutcome, type RunningChild, spawnChild } from './child.ts';
import { chartFileName, RESULT_FILE_NAMES } from './contract/layout.ts';
import { buildRunManifest, type ChildResult } from './contract/messages.ts';
import { classifyAttemptFailure, retryOnTransientDbError } from './failures.ts';
import {
  loadAttemptInputs,
  markAttemptCanceled,
  markAttemptFailed,
  markAttemptSucceeded,
  type ResultFileRecord,
} from './queue.ts';
import {
  createRunDirectory,
  readFailure,
  readResult,
  readResultFiles,
  removeRunDirectory,
  writeInputCsv,
  writeManifest,
} from './run-directory.ts';
import { type ChildEnding, classifyVerdict, type Kill, type Verdict } from './verdict.ts';

export type AttemptDependencies = {
  db: DatabaseExecutor;
  store: BlobStore;
  workerId: string;
  runRoot: string;
  childCommand: ChildCommand;
  killGraceMs: number;
};

export type PreparedAttempt = {
  attemptId: AnalysisAttemptId;
  organizationId: OrganizationId;
  reportId: ReportId;
  runDirectory: string;
  child: RunningChild;
};

/** Thrown by `startAttempt` when the report's input object is gone from the blob store — a state
 * the queue's own invariants should prevent, but the filesystem and the database can still drift
 * apart.
 */
export class MissingInputFileError extends Error {
  constructor(readonly storageKey: string) {
    super(`input file missing at ${storageKey}`);
  }
}

// -------------------------------------------------------------
// Starting an attempt
// -------------------------------------------------------------

/** Load a claimed attempt's inputs, build its run directory, and spawn its child. */
export async function startAttempt(
  dependencies: AttemptDependencies,
  attemptId: AnalysisAttemptId,
): Promise<PreparedAttempt> {
  let runDirectory: string | undefined;
  try {
    const inputs = await retryOnTransientDbError(
      () => loadAttemptInputs(dependencies.db, attemptId),
      {
        action: "load a claimed attempt's inputs",
        context: { attemptId },
      },
    );

    runDirectory = await createRunDirectory(dependencies.runRoot, attemptId);

    const inputCsv = await getObject(dependencies.store, inputs.inputFile.storageKey);
    if (inputCsv === undefined) throw new MissingInputFileError(inputs.inputFile.storageKey);
    await writeInputCsv(runDirectory, inputCsv);

    const manifest = buildRunManifest({
      analysisAttemptId: attemptId,
      report: inputs.report,
      inputFile: {
        originalFilename: inputs.inputFile.originalFilename,
        byteSize: inputs.inputFile.byteSize,
        checksumSha256: inputs.inputFile.checksumSha256,
      },
    });
    await writeManifest(runDirectory, manifest);

    const child = spawnChild(dependencies.childCommand, runDirectory, {
      killGraceMs: dependencies.killGraceMs,
    });

    return {
      attemptId,
      organizationId: inputs.organizationId,
      reportId: inputs.reportId,
      runDirectory,
      child,
    };
  } catch (error) {
    if (runDirectory !== undefined) await removeRunDirectory(runDirectory);
    throw error;
  }
}

// -------------------------------------------------------------
// Reading how the child ended
// -------------------------------------------------------------

type DeclaredResultFile = { fileName: string } & (
  | { kind: 'chart'; chartKey: string }
  | { kind: Exclude<ResultFileKind, 'chart'> }
);

function declaredResultFiles(result: ChildResult): DeclaredResultFile[] {
  const fixed = Object.entries(RESULT_FILE_NAMES).map(([kind, fileName]) => ({
    kind: kind as Exclude<ResultFileKind, 'chart'>,
    fileName,
  }));
  const charts = result.charts.map((chartKey) => ({
    kind: 'chart' as const,
    chartKey,
    fileName: chartFileName(chartKey),
  }));
  return [...fixed, ...charts];
}

/** `readChildEnding`'s result, carrying the bytes a `succeeded` verdict will upload alongside the
 * `ChildEnding` `classifyVerdict` decides from — read once here rather than a second time in
 * `settleAttempt`.
 */
export type ReadEnding = ChildEnding & { resultFileContents: ReadonlyMap<string, Uint8Array> };

/** Read whatever documents the child's exit code says it should have written. Any read failure —
 * a malformed document, a permissions error — becomes `readError` rather than propagating, so
 * `classifyVerdict` can turn it into a verdict instead of an unhandled rejection reaching the
 * caller.
 */
export async function readChildEnding(
  prepared: PreparedAttempt,
  outcome: ChildOutcome,
  kill?: Kill,
): Promise<ReadEnding> {
  const notRead: ReadEnding = {
    outcome,
    kill,
    read: { kind: 'not-read' },
    resultFileContents: new Map(),
  };
  if (outcome.kind !== 'exited') return notRead;

  try {
    if (outcome.exitCode === 0) {
      const result = await readResult(prepared.runDirectory);
      if (result === undefined) return notRead;
      const { missing, contents } = await readResultFiles(
        prepared.runDirectory,
        declaredResultFiles(result).map((file) => file.fileName),
      );
      return {
        outcome,
        kill,
        read: { kind: 'result', result, missingResultFiles: missing },
        resultFileContents: contents,
      };
    }
    if (outcome.exitCode === 1) {
      const failure = await readFailure(prepared.runDirectory);
      if (failure === undefined) return notRead;
      return { ...notRead, read: { kind: 'failure', failure } };
    }
    return notRead;
  } catch (error) {
    return { ...notRead, read: { kind: 'read-error', error } };
  }
}

// -------------------------------------------------------------
// Recording a verdict
// -------------------------------------------------------------

type SucceededVerdict = Extract<Verdict, { kind: 'succeeded' }>;

/** A verdict with everything its `markAttempt*` write needs attached, so `recordVerdict` never
 * has to look anything up itself.
 */
export type RecordableVerdict =
  | (SucceededVerdict & { resultFiles: readonly ResultFileRecord[] })
  | Exclude<Verdict, { kind: 'succeeded' | 'unowned' }>;

/** Write a verdict this worker already computed. Bounded transient retry, per principle 4 in
 * [`failures.ts`](./failures.ts): this is one of the writes a claimed attempt cannot afford to
 * lose to a blip. Returns whether we still owned the attempt, exactly like the `markAttempt*`
 * helpers this wraps.
 */
export async function recordVerdict(
  dependencies: AttemptDependencies,
  attemptId: AnalysisAttemptId,
  verdict: RecordableVerdict,
): Promise<boolean> {
  return await retryOnTransientDbError(() => writeVerdictOnce(dependencies, attemptId, verdict), {
    action: 'record an attempt verdict',
    context: { attemptId, verdict: verdict.kind },
  });
}

function writeVerdictOnce(
  dependencies: AttemptDependencies,
  attemptId: AnalysisAttemptId,
  verdict: RecordableVerdict,
): Promise<boolean> {
  switch (verdict.kind) {
    case 'succeeded':
      return markAttemptSucceeded(dependencies.db, attemptId, dependencies.workerId, {
        result: verdict.result,
        resultFiles: verdict.resultFiles,
      });
    case 'failed':
      return markAttemptFailed(dependencies.db, attemptId, dependencies.workerId, {
        reason: verdict.reason,
        detail: verdict.detail,
      });
    case 'canceled':
      return markAttemptCanceled(dependencies.db, attemptId, dependencies.workerId);
  }
}

// -------------------------------------------------------------
// Settling an attempt
// -------------------------------------------------------------

/** A verdict this worker owns and still owes the database, and how far delivering it got.
 *
 * Settling is two steps that can each fail independently — storing the result files, then
 * writing the verdict — so this says which one is left. `worker.ts` holds it on the in-flight
 * record and calls `resumeSettle` on a later tick.
 */
export type PendingVerdict =
  /** The child succeeded and its result files are not stored yet. */
  | { stage: 'upload'; verdict: SucceededVerdict; contents: ReadonlyMap<string, Uint8Array> }
  /** Every file is stored; only the database write is left. */
  | { stage: 'record'; verdict: RecordableVerdict };

export type SettleOutcome =
  | { kind: 'recorded' }
  | { kind: 'lost' }
  /** A step could not be completed even after its own retries. The child is already dead and the
   * run directory already gone, so nothing is lost by trying again.
   */
  | { kind: 'parked'; pending: PendingVerdict };

/** Classify how the child ended, then deliver that verdict as far as it gets.
 *
 * The run directory is removed in a `finally`, so it is gone whether the verdict
 * landed, lost the race, or parked.
 */
export async function settleAttempt(
  dependencies: AttemptDependencies,
  prepared: PreparedAttempt,
  ending: ReadEnding,
): Promise<SettleOutcome> {
  try {
    const verdict = classifyVerdict(ending);
    if (verdict.kind === 'unowned') return { kind: 'lost' };

    return await resumeSettle(
      dependencies,
      prepared,
      verdict.kind === 'succeeded'
        ? { stage: 'upload', verdict, contents: ending.resultFileContents }
        : { stage: 'record', verdict },
    );
  } finally {
    await removeRunDirectory(prepared.runDirectory);
  }
}

/** Carry a parked verdict the rest of the way, from whichever step it stopped at.
 *
 * `settleAttempt` is the first of these; every later one comes from a supervision tick. Classifying
 * happens only in `settleAttempt`, which is what makes an `unowned` verdict unrepresentable here.
 */
export async function resumeSettle(
  dependencies: AttemptDependencies,
  prepared: PreparedAttempt,
  pending: PendingVerdict,
): Promise<SettleOutcome> {
  const stored =
    pending.stage === 'upload'
      ? await storeResultFiles(dependencies.store, prepared, pending)
      : pending;
  if (stored.stage === 'upload') return { kind: 'parked', pending: stored };

  try {
    const won = await recordVerdict(dependencies, prepared.attemptId, stored.verdict);
    return won ? { kind: 'recorded' } : { kind: 'lost' };
  } catch (error) {
    console.error(
      `Could not record the verdict for attempt ${prepared.attemptId}; parking it for the ` +
        'next supervision tick to retry',
      { verdict: stored.verdict.kind, error },
    );
    return { kind: 'parked', pending: stored };
  }
}

/** Store every file the child declared, advancing the verdict to `record`. A blob store that could
 * not be reached hands back the same `upload` verdict for the caller to park.
 *
 * A resume re-uploads every file rather than tracking which ones landed. The failure that matters
 * is an unreachable store, where none of them did; and the objects a partial success orphans are
 * a report of a few hundred KB, well under what the bookkeeping would cost to read. Uploads also
 * precede the write, so a verdict that never lands orphans the same way. Both are acceptable under
 * "no automated data cleanup" in REQUIREMENTS.md.
 */
async function storeResultFiles(
  store: BlobStore,
  prepared: PreparedAttempt,
  pending: Extract<PendingVerdict, { stage: 'upload' }>,
): Promise<PendingVerdict> {
  try {
    const resultFiles = await Promise.all(
      declaredResultFiles(pending.verdict.result).map((file) => {
        const body = pending.contents.get(file.fileName);
        if (body === undefined) {
          // classifyVerdict only reaches `succeeded` when `missingResultFiles` is empty, so every
          // declared file's bytes were read alongside it.
          throw new Error(`settleAttempt: no bytes read for declared file ${file.fileName}`);
        }
        return uploadResultFile(store, prepared, file, body);
      }),
    );
    return { stage: 'record', verdict: { ...pending.verdict, resultFiles } };
  } catch (error) {
    // Only the store being unreachable parks. Anything else is a bug in this file — the missing
    // bytes above — and parking it would retry a deterministic failure on every later tick.
    if (!isBlobStoreError(error)) throw error;
    console.error(
      `Could not store the result files for attempt ${prepared.attemptId}; parking the verdict ` +
        'for the next supervision tick to retry',
      { error },
    );
    return pending;
  }
}

async function uploadResultFile(
  store: BlobStore,
  prepared: PreparedAttempt,
  file: DeclaredResultFile,
  body: Uint8Array,
): Promise<ResultFileRecord> {
  const id = newResultFileId();
  const stored = await putResultFile(
    store,
    {
      organizationId: prepared.organizationId,
      reportId: prepared.reportId,
      analysisAttemptId: prepared.attemptId,
      resultFileId: id,
      kind: file.kind,
    },
    body,
  );
  return file.kind === 'chart'
    ? { ...stored, id, kind: 'chart', chartKey: file.chartKey }
    : { ...stored, id, kind: file.kind };
}

// -------------------------------------------------------------
// Failing a claimed attempt outright
// -------------------------------------------------------------

/** What to record when processing a claimed attempt throws before a verdict is ever classified —
 * `startAttempt` failing, most likely.
 */
export async function failClaimedAttempt(
  dependencies: AttemptDependencies,
  attemptId: AnalysisAttemptId,
  error: unknown,
): Promise<void> {
  const failure =
    // Deterministic, so recorded directly instead of through `classifyAttemptFailure`, which
    // would otherwise see only an ordinary `Error` and have to guess at `unknown`.
    error instanceof MissingInputFileError
      ? { reason: 'infrastructure' as const, detail: error.message }
      : classifyAttemptFailure(error);

  await recordVerdict(dependencies, attemptId, {
    kind: 'failed',
    reason: failure.reason,
    detail: failure.detail,
  });
}
