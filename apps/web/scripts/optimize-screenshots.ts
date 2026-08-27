/// <reference types="node" />

/** Shrink the committed PNGs losslessly, so a gallery that only grows costs the repository less.
 *
 * `toHaveScreenshot` compares decoded pixels, so an optimized PNG and the bytes Chromium emitted
 * still compare equal. This only ever runs from `screenshots:update` (never from a check).
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCREENSHOTS_DIR = fileURLToPath(new URL('../e2e/__screenshots__/', import.meta.url));

const run = promisify(execFile);

try {
  await run('oxipng', ['--opt', 'max', '--strip', 'safe', '--recursive', SCREENSHOTS_DIR]);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  throw new Error(
    'oxipng is required to update screenshots, so a stale, unoptimized image never gets ' +
      'committed. Install it with `brew install oxipng` (or `cargo install oxipng`).',
  );
}
