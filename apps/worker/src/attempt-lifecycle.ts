/** One attempt, start to finish: load its inputs, spawn its child, read how the child ended, and
 * write the verdict. [`verdict.ts`](./verdict.ts) is the pure decision this file feeds and acts
 * on; [`worker.ts`](./worker.ts) (landing with the supervision loop) is what decides *when* to
 * call each of these and what to do with an in-flight record between calls.
 */

import { readFile } from 'node:fs/promises';
import type { DatabaseExecutor } from '@gbd/db';
import {
  type AnalysisAttemptId,
  newResultFileId,
  type OrganizationId,
  type ReportId,
  type ResultFileKind,
} from '@gbd/db';
import { type BlobStore, getObject, putResultFile } from '@gbd/storage';
import { type ChildCommand, type ChildOutcome, type RunningChild, spawnChild } from './child.ts';
import { chartFileName, RESULT_FILE_NAMES, resultFilePath } from './contract/layout.ts';
import { buildRunManifest, type ChildResult } from './contract/messages.ts';
import { classifyAttemptFailure, retryOnTransientDbError } from './failures.ts';
import {
  finishCanceled,
  finishFailed,
  finishSucceeded,
  loadAttemptInputs,
  type ResultFileRecord,
} from './queue.ts';
import {
  createRunDirectory,
  readFailure,
  readResult,
  removeRunDirectory,
  writeInputCsv,
  writeManifest,
} from './run-directory.ts';
import { type ChildEnding, classifyVerdict, type Kill, type Verdict } from './verdict.ts';

/** The database, blob store, and child-invocation settings every function below needs. A subset
 * of `WorkerConfig` (landing with the supervision loop) plus the two live handles — kept as its
 * own type here so this file has no dependency on a config nobody constructs yet.
 */
export type AttemptDeps = {
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
 * apart. Deterministic, so `failClaimedAttempt` fails the attempt on it without retrying.
 */
export class MissingInputFileError extends Error {
  constructor(readonly storageKey: string) {
    super(`input file missing at ${storageKey}`);
  }
}

/** Load a claimed attempt's inputs, build its run directory, and spawn its child. */
export async function startAttempt(
  deps: AttemptDeps,
  attemptId: AnalysisAttemptId,
): Promise<PreparedAttempt> {
  let runDirectory: string | undefined;
  try {
    const inputs = await retryOnTransientDbError(() => loadAttemptInputs(deps.db, attemptId), {
      action: "load a claimed attempt's inputs",
      context: { attemptId },
    });

    runDirectory = await createRunDirectory(deps.runRoot, attemptId);

    const inputCsv = await getObject(deps.store, inputs.inputFile.storageKey);
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

    const child = spawnChild(deps.childCommand, runDirectory, { killGraceMs: deps.killGraceMs });

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

/** What `result.json` declares, whichever fixed name or chart key produced it — the directory is
 * never listed, so this is the only way a path is derived (`contract/layout.ts`).
 */
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
  const empty: ReadEnding = {
    outcome,
    kill,
    missingResultFiles: [],
    resultFileContents: new Map(),
  };
  if (outcome.kind !== 'exited') return empty;

  try {
    if (outcome.exitCode === 0) {
      const result = await readResult(prepared.runDirectory);
      if (result === undefined) return empty;
      const { missing, contents } = await readDeclaredResultFiles(prepared.runDirectory, result);
      return { outcome, kill, result, missingResultFiles: missing, resultFileContents: contents };
    }
    if (outcome.exitCode === 1) {
      return { ...empty, failure: await readFailure(prepared.runDirectory) };
    }
    return empty;
  } catch (readError) {
    return { ...empty, readError };
  }
}

async function readDeclaredResultFiles(
  runDirectory: string,
  result: ChildResult,
): Promise<{ missing: string[]; contents: Map<string, Uint8Array> }> {
  const missing: string[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const file of declaredResultFiles(result)) {
    const bytes = await readFile(resultFilePath(runDirectory, file.fileName)).catch(
      undefinedIfMissing,
    );
    if (bytes === undefined) missing.push(file.fileName);
    else contents.set(file.fileName, bytes);
  }
  return { missing, contents };
}

function undefinedIfMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}

/** A verdict with everything its `finish*` write needs attached, so `recordVerdict` never has to
 * look anything up itself.
 */
export type RecordableVerdict = Exclude<Verdict, { kind: 'unowned' }> & {
  resultFiles?: readonly ResultFileRecord[];
};

/** Write a verdict this worker already computed. Bounded transient retry, per principle 4 in
 * [`failures.ts`](./failures.ts): this is one of the writes a claimed attempt cannot afford to
 * lose to a blip. Returns whether we still owned the attempt, exactly like the `finish*` helpers
 * this wraps.
 */
export async function recordVerdict(
  deps: AttemptDeps,
  attemptId: AnalysisAttemptId,
  verdict: RecordableVerdict,
): Promise<boolean> {
  return await retryOnTransientDbError(() => writeVerdict(deps, attemptId, verdict), {
    action: 'record an attempt verdict',
    context: { attemptId, verdict: verdict.kind },
  });
}

function writeVerdict(
  deps: AttemptDeps,
  attemptId: AnalysisAttemptId,
  verdict: RecordableVerdict,
): Promise<boolean> {
  switch (verdict.kind) {
    case 'succeeded':
      return finishSucceeded(deps.db, attemptId, deps.workerId, {
        result: verdict.result,
        resultFiles: verdict.resultFiles ?? [],
      });
    case 'failed':
      return finishFailed(deps.db, attemptId, deps.workerId, {
        reason: verdict.reason,
        detail: verdict.detail,
      });
    case 'canceled':
      return finishCanceled(deps.db, attemptId, deps.workerId);
  }
}

export type SettleOutcome =
  | { kind: 'recorded' }
  | { kind: 'lost' }
  /** `recordVerdict` could not be written even after its own retries. The child is already dead
   * and the run directory already gone, so nothing is lost by trying again — `worker.ts` keeps
   * this verdict on the in-flight record and re-attempts the write on a later supervision tick.
   */
  | { kind: 'parked'; verdict: RecordableVerdict };

/** Classify how the child ended, upload whatever a `succeeded` verdict produced, and write the
 * verdict. The run directory is removed in a `finally`, so it is gone whether the write landed,
 * lost the race, or parked.
 *
 * Uploads happen before the write, so a write that then fails to land — permanently, or parked
 * and never retried successfully — orphans the objects it already stored. Acceptable per
 * "no automated data cleanup" in REQUIREMENTS.md, and not worth a second retry layer here: the
 * blob store SDK already retries its own transient failures.
 */
export async function settleAttempt(
  deps: AttemptDeps,
  prepared: PreparedAttempt,
  ending: ReadEnding,
): Promise<SettleOutcome> {
  try {
    const verdict = classifyVerdict(ending);
    if (verdict.kind === 'unowned') return { kind: 'lost' };

    const recordable = await toRecordable(deps, prepared, verdict, ending);
    try {
      const won = await recordVerdict(deps, prepared.attemptId, recordable);
      return won ? { kind: 'recorded' } : { kind: 'lost' };
    } catch (error) {
      console.error(
        `Could not record the verdict for attempt ${prepared.attemptId}; parking it for the ` +
          'next supervision tick to retry',
        { verdict: recordable.kind, error },
      );
      return { kind: 'parked', verdict: recordable };
    }
  } finally {
    await removeRunDirectory(prepared.runDirectory);
  }
}

async function toRecordable(
  deps: AttemptDeps,
  prepared: PreparedAttempt,
  verdict: Exclude<Verdict, { kind: 'unowned' }>,
  ending: ReadEnding,
): Promise<RecordableVerdict> {
  if (verdict.kind !== 'succeeded') return verdict;

  const resultFiles = await Promise.all(
    declaredResultFiles(verdict.result).map((file) =>
      uploadResultFile(deps, prepared, file, ending.resultFileContents),
    ),
  );
  return { ...verdict, resultFiles };
}

async function uploadResultFile(
  deps: AttemptDeps,
  prepared: PreparedAttempt,
  file: DeclaredResultFile,
  contents: ReadonlyMap<string, Uint8Array>,
): Promise<ResultFileRecord> {
  const body = contents.get(file.fileName);
  if (body === undefined) {
    // classifyVerdict only reaches `succeeded` when `missingResultFiles` is empty, so every
    // declared file's bytes were read alongside it.
    throw new Error(`settleAttempt: no bytes read for declared file ${file.fileName}`);
  }

  const id = newResultFileId();
  const stored = await putResultFile(
    deps.store,
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

/** What to record when processing a claimed attempt throws before a verdict was ever classified —
 * `startAttempt` failing, most likely. A `MissingInputFileError` is deterministic, so it is
 * recorded directly rather than run through `classifyAttemptFailure`, which would otherwise see
 * an ordinary `Error` and only be able to guess at `unknown`.
 */
export async function failClaimedAttempt(
  deps: AttemptDeps,
  attemptId: AnalysisAttemptId,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof MissingInputFileError
      ? { reason: 'infrastructure' as const, detail: error.message }
      : classifyAttemptFailure(error);

  await recordVerdict(deps, attemptId, {
    kind: 'failed',
    reason: failure.reason,
    detail: failure.detail,
  });
}
