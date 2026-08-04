/** Reading environment variables outside of Vite.
 *
 * **Node only.** Never import this from Svelte components or SvelteKit `load`/route code —
 * use `$env/dynamic/private` there, which SvelteKit populates from the same `.env` files in
 * dev and from the real environment in production.
 *
 * This module exists for the places that run outside Vite and therefore cannot resolve
 * `$env/*`: `packages/db`'s scripts and vitest suites, and the worker parent process when
 * it lands.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Marks the repo root. Also the file pnpm itself uses to find the workspace. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Walk up from the working directory to the repo root.
 *
 * Deliberately not `import.meta.dirname`, which moves when a caller bundles this file.
 * pnpm runs scripts from the package directory, always somewhere under the repo root.
 */
export function findRepoRoot(startingFrom: string = process.cwd()): string {
  let directory = startingFrom;
  while (!existsSync(join(directory, WORKSPACE_MARKER))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not find ${WORKSPACE_MARKER} at or above ${startingFrom}, so the repo root is unknown`,
      );
    }
    directory = parent;
  }
  return directory;
}

/** Load the repo root's `.env`, or `.env.test` when `TEST_DB` is set.
 *
 * Variables already in the environment win over the file — `loadEnvFile` does not overwrite
 * them — which is what lets CI and production inject real values, and lets you point a
 * single command at another database inline. A missing file is not an error, for the same
 * reason. `env.test.ts` pins both behaviours.
 *
 * Safe to call more than once.
 */
export function loadLocalEnv(): void {
  const fileName = process.env.TEST_DB ? '.env.test' : '.env';
  const path = join(findRepoRoot(), fileName);
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Read an environment variable, failing loudly rather than at first use. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new Error(
    `Must set the env var '${name}'. Add it to .env (or .env.test when TEST_DB is set) ` +
      'at the repo root — see the README.',
  );
}
