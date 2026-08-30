/// <reference types="node" />

/** Shrink the committed PNGs losslessly, so a gallery that only grows costs the repository less.
 *
 * `toHaveScreenshot` compares decoded pixels, so an optimized PNG and the bytes Chromium emitted
 * still compare equal. Called both as the standalone `screenshots:update` script and from
 * `e2e/setup/optimize-screenshots.teardown.ts`.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const SCREENSHOTS_DIR = fileURLToPath(new URL('../e2e/__screenshots__/', import.meta.url));

const run = promisify(execFile);

/** True if a run added or changed a committed screenshot, per git's own view of the tree. */
export async function wroteScreenshots(): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain', '--', SCREENSHOTS_DIR]);
  return stdout.trim().length > 0;
}

export async function optimizeScreenshots(): Promise<void> {
  try {
    await run('oxipng', ['--opt', 'max', '--strip', 'safe', '--recursive', SCREENSHOTS_DIR]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      'oxipng is required to update screenshots, so a stale, unoptimized image never gets ' +
        'committed. Install it with `brew install oxipng` (or `cargo install oxipng`).',
    );
  }
}

// `import.meta.main` is undefined when this module is imported rather than run directly (e.g.
// from the teardown project), so the CLI entry point only fires for the standalone script.
if (import.meta.main) await optimizeScreenshots();
