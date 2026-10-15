/** Where every file lives in the worker's run directory.
 *
 * ```
 * <runRoot>/{analysis_attempt_id}
 *     /input          run.json, input.csv
 *     /output         progress.json, result.json, failure.json, telemetry.json
 *         /files      report.pdf, report.xlsx
 *     /work           child scratch
 * ```
 *
 * The parent creates every directory before spawning; the child creates none, so a missing one
 * means the parent broke its own contract. The parent never lists `output/files` — it derives
 * each expected path from the two fixed report names, which makes traversal impossible by
 * construction. A path segment is always an id or a fixed name, never anything a user typed.
 *
 * `work/` is the child's working directory, so a stray relative write — from the library or
 * anything it spawns — lands in scratch rather than among the results.
 *
 * `telemetry.json` is the one document not tied to an exit code. The child rewrites it as each LLM
 * call and stage finishes, so a run that fails, is killed, or is never ours to settle still says
 * what it spent and how far it got. The parent reads it on every ending, and it never decides a
 * verdict: a missing one means the child never got far enough to write it.
 */

import { join } from 'node:path';
import type { ResultFileKind } from '@gbd/db';

export const RUN_DIRECTORY = {
  manifest: 'input/run.json',
  inputCsv: 'input/input.csv',
  progress: 'output/progress.json',
  result: 'output/result.json',
  failure: 'output/failure.json',
  telemetry: 'output/telemetry.json',
  resultFilesDirectory: 'output/files',
  workDirectory: 'work',
} as const;

export type RunDirectoryEntry = keyof typeof RUN_DIRECTORY;

export const DIRECTORIES_CREATED_BY_PARENT = ['input', 'output', 'output/files', 'work'] as const;

export const RESULT_FILE_NAMES = {
  pdf: 'report.pdf',
  xlsx: 'report.xlsx',
} as const satisfies Record<ResultFileKind, string>;

export function runPath(runDirectory: string, entry: RunDirectoryEntry): string {
  return join(runDirectory, RUN_DIRECTORY[entry]);
}

export function resultFilePath(runDirectory: string, fileName: string): string {
  return join(runDirectory, RUN_DIRECTORY.resultFilesDirectory, fileName);
}
