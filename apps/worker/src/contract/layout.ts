/** Where every file lives in the worker's run directory.
 *
 * ```
 * <runRoot>/{analysis_attempt_id}
 *     /input          run.json, input.csv
 *     /output         progress.json, result.json, failure.json
 *         /files      report.pdf, report.xlsx, chart-{chart_key}.png
 *     /work           child scratch
 * ```
 *
 * The parent creates every directory before spawning; the child creates none, so a missing one
 * means the parent broke its own contract. The parent never lists `output/files` — it derives
 * each expected path from the chart keys `result.json` declares plus the two fixed report names,
 * which makes traversal impossible by construction. A path segment is always an id or a fixed
 * name, never anything a user typed.
 *
 * `work/` exists because the analysis library writes CSV intermediates; the child's working
 * directory is `work/`, so a stray relative write lands in scratch rather than among the results.
 */

import { join } from 'node:path';
import type { ResultFileKind } from '@gbd/db';

export const RUN_DIRECTORY = {
  manifest: 'input/run.json',
  inputCsv: 'input/input.csv',
  progress: 'output/progress.json',
  result: 'output/result.json',
  failure: 'output/failure.json',
  resultFilesDirectory: 'output/files',
  workDirectory: 'work',
} as const;

export type RunDirectoryEntry = keyof typeof RUN_DIRECTORY;

export const DIRECTORIES_CREATED_BY_PARENT = ['input', 'output', 'output/files', 'work'] as const;

export const RESULT_FILE_NAMES = {
  pdf: 'report.pdf',
  xlsx: 'report.xlsx',
} as const satisfies Record<Exclude<ResultFileKind, 'chart'>, string>;

export const CHART_KEY_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

export function chartFileName(chartKey: string): string {
  return `chart-${chartKey}.png`;
}

export function runPath(runDirectory: string, entry: RunDirectoryEntry): string {
  return join(runDirectory, RUN_DIRECTORY[entry]);
}

export function resultFilePath(runDirectory: string, fileName: string): string {
  return join(runDirectory, RUN_DIRECTORY.resultFilesDirectory, fileName);
}
