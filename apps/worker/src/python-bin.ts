/** Anchoring `PYTHON_BIN` to the repo root.
 *
 * `PYTHON_BIN` is conventionally relative (`.venv/bin/python`), meant against the repo root. But
 * pnpm runs this process from the package directory, and `spawnChild` runs the child from its own
 * run directory — neither is the repo root, so a relative path resolves nowhere and `spawn` fails
 * with `ENOENT`. Resolving it here, once at startup, means `resolveWorkerMode` and `spawnChild`
 * only ever see an absolute path.
 */

import { isAbsolute, join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';

export function resolvePythonBin(pythonBin: string | undefined): string | undefined {
  if (pythonBin === undefined || isAbsolute(pythonBin)) return pythonBin;
  return join(findRepoRoot(), pythonBin);
}
