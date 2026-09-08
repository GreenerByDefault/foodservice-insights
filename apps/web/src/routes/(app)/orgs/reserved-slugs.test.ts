/** `RESERVED_ORGANIZATION_SLUGS` exists because SvelteKit routes a static directory ahead of a
 * dynamic one: a static `foo` here would make an organization slugged `foo` a real route and so
 * unreachable. Reads the actual directory listing rather than a hardcoded copy of it, so a new
 * static route added under here without reserving its name fails this test instead of quietly
 * shadowing an organization someday.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_ORGANIZATION_SLUGS } from '@gbd/db';
import { describe, expect, test } from 'vitest';

const ORGS_DIR = dirname(fileURLToPath(import.meta.url));

/** Every static (non-`[param]`) directory directly under `orgs/` — the segments SvelteKit routes
 * ahead of the dynamic `[organizationSlug=slug]` one. */
function staticSubdirectories(): string[] {
  return readdirSync(ORGS_DIR).filter((name) => {
    if (name.startsWith('[')) return false;
    return statSync(join(ORGS_DIR, name)).isDirectory();
  });
}

describe('reserved organization slugs', () => {
  test('every static directory under orgs/ is reserved', () => {
    for (const name of staticSubdirectories()) {
      expect(RESERVED_ORGANIZATION_SLUGS as readonly string[]).toContain(name);
    }
  });
});
