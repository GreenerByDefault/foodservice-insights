/** Reading environment variables outside of Vite.
 *
 * **Node only.** Never import this from Svelte components or SvelteKit `load`/route code —
 * use `$env/dynamic/private` there, which SvelteKit populates from the same `.env` files in
 * dev and from the real environment in production.
 *
 * This module exists for the places that run outside Vite, like the worker process.
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
 * Variables already in the environment win over the file. Safe to call more than once.
 *
 * Tolerates finding no repo root: a pruned deploy image has no `pnpm-workspace.yaml`, and a
 * platform injects real env vars there instead of shipping a `.env` file.
 */
export function loadLocalEnv(): void {
  let root: string;
  try {
    root = findRepoRoot();
  } catch {
    return;
  }
  const fileName = process.env.TEST_DB ? '.env.test' : '.env';
  const path = join(root, fileName);
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Read an environment variable and error if not set. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new Error(
    `Must set the env var '${name}'. Add it to .env (or .env.test when TEST_DB is set) ` +
      'at the repo root — see the README.',
  );
}

export function optionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number, not '${raw}'`);
  return value;
}
