/** A run root of its own for every test, so tests that spawn real children stay isolated from each
 * other. */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTemporaryRunRoot<T>(body: (runRoot: string) => Promise<T>): Promise<T> {
  const runRoot = await mkdtemp(join(await realpath(tmpdir()), 'gbd-worker-'));
  try {
    return await body(runRoot);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
