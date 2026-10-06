/** Reads the route tree rather than a list of pages, so a new page without a title fails here
 * instead of shipping one that tabs, history, and SvelteKit's route announcer show as untitled.
 * `+error.svelte` is exempt: each renders `ErrorPage`, which sets its own.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

function pageFiles(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' }).filter((path) =>
    path.endsWith('+page.svelte'),
  );
}

describe('page titles', () => {
  test.each(pageFiles())('%s sets its <title> through pageTitle', (path) => {
    const source = readFileSync(join(ROUTES_DIR, path), 'utf8');
    expect(source).toContain('<title>{pageTitle(');
  });
});
