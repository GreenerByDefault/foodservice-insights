/** A run root of its own for every test, so tests that spawn real children stay isolated from each
 * other the way `withTemporaryPrefix` isolates blob-store tests. */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTemporaryRunRoot<T>(body: (runRoot: string) => Promise<T>): Promise<T> {
  // Resolved, because a spawned child's `process.cwd()` reports the real path — on macOS `tmpdir()`
  // is a symlink, and an unresolved root turns "the child ran in `work/`" into a false failure.
  const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'gbd-worker-'));
  try {
    return await body(runRoot);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
