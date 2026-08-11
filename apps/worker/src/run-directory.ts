/** The parent's side of the run directory. The layout itself, and why the parent creates every
 * directory and never lists one, is documented on [`contract/layout.ts`](./contract/layout.ts).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisAttemptId } from '@gbd/db';
import {
  DIRECTORIES_CREATED_BY_PARENT,
  type RunDirectoryEntry,
  runPath,
} from './contract/layout.ts';
import {
  type ChildFailure,
  type ChildResult,
  type Progress,
  parseFailure,
  parseProgress,
  parseResult,
  type RunManifest,
} from './contract/messages.ts';

export async function createRunDirectory(
  runRoot: string,
  analysisAttemptId: AnalysisAttemptId,
): Promise<string> {
  const runDirectory = join(runRoot, analysisAttemptId);
  for (const directory of DIRECTORIES_CREATED_BY_PARENT) {
    await mkdir(join(runDirectory, directory), { recursive: true });
  }
  return runDirectory;
}

export async function writeManifest(runDirectory: string, manifest: RunManifest): Promise<void> {
  await writeFile(runPath(runDirectory, 'manifest'), JSON.stringify(manifest));
}

export async function writeInputCsv(runDirectory: string, body: Uint8Array): Promise<void> {
  await writeFile(runPath(runDirectory, 'inputCsv'), body);
}

export async function readProgress(runDirectory: string): Promise<Progress | undefined> {
  return await readDocument(runDirectory, 'progress', parseProgress);
}

export async function readResult(runDirectory: string): Promise<ChildResult | undefined> {
  return await readDocument(runDirectory, 'result', parseResult);
}

export async function readFailure(runDirectory: string): Promise<ChildFailure | undefined> {
  return await readDocument(runDirectory, 'failure', parseFailure);
}

/** Does not mind the tree being gone already, so it is safe in the `finally` that always calls it. */
export async function removeRunDirectory(runDirectory: string): Promise<void> {
  await rm(runDirectory, { recursive: true, force: true });
}

/** A document the child has not written is `undefined`; one it wrote badly is a `ContractError`.
 *
 * There is deliberately no third case for "caught it half-written". The child writes every document
 * under a temporary name and renames it into place, and rename is atomic within a filesystem — so
 * malformed JSON here is always a real contract violation and never a torn read, which is what
 * makes it safe to fail the attempt on.
 */
async function readDocument<T>(
  runDirectory: string,
  entry: RunDirectoryEntry,
  parse: (text: string) => T,
): Promise<T | undefined> {
  const text = await readFile(runPath(runDirectory, entry), 'utf8').catch(undefinedIfMissing);
  return text === undefined ? undefined : parse(text);
}

function undefinedIfMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}
