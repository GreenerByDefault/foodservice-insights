/** Where every file lives in a run directory — the only seam between the parent and its child.
 *
 * ```
 * <runRoot>/{analysis_attempt_id}
 *     /input          run.json, input.csv
 *     /output         progress.json, result.json, failure.json
 *         /files      report.pdf, report.xlsx, chart-{chart_key}.png
 *     /work           child scratch
 * ```
 *
 * Three rules hold it together:
 *
 * 1. **The parent creates every directory; the child creates none.** A missing directory means
 *    the parent broke its own contract, so the child fails loudly instead of papering over it.
 * 2. **A segment is an id or a fixed name, never anything a user typed.** The uploaded filename
 *    travels in `run.json` and never reaches the filesystem, so no path needs escaping — the same
 *    rule `packages/storage/src/keys.ts` applies to blob keys.
 * 3. **The parent never lists `output/files`.** It derives each expected path from the chart keys
 *    `result.json` declares, plus the two fixed report names. A manifest therefore cannot name a
 *    path at all, which makes traversal impossible by construction rather than by validation.
 *
 * `work/` exists because the analysis library writes CSV intermediates. The child's working
 * directory is `work/`, so a stray relative write lands in scratch rather than among the results.
 *
 * - *Rejected: the child creating its own directories.* It makes "who owns this path"
 *   unanswerable, and hides the parent bug that a missing directory represents.
 * - *Rejected: `result.json` carrying file paths rather than chart keys.* Derived names cannot
 *   escape the run directory; supplied ones have to be checked, and that check is easy to forget.
 * - *Rejected: kebab-case chart keys.* `chart-emissions-by-month.png` hides where the fixed
 *   prefix stops and the key starts; snake_case keeps that boundary legible.
 */

import { join } from 'node:path';
import type { ResultFileKind } from '@gbd/db';

/** Paths within a run directory, relative to its root. */
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

/** Created by the parent before it spawns, deepest last so a plain loop suffices. */
export const DIRECTORIES_CREATED_BY_PARENT = ['input', 'output', 'output/files', 'work'] as const;

/** The result files that every successful run produces, keyed by the database's own
 * `result_file_kind`. `chart` is absent because charts are named from their key instead, so
 * adding a fourth kind is a compile error here until someone decides which side it falls on.
 */
export const RESULT_FILE_NAMES = {
  pdf: 'report.pdf',
  xlsx: 'report.xlsx',
} as const satisfies Record<Exclude<ResultFileKind, 'chart'>, string>;

/** Chart keys are snake_case; see the rejected alternative above. */
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
