// SvelteKit 2 fills `$app/env/*` only from `Server.init`, which vitest never runs, so every
// variable would read as `undefined`. This does what kit 3 does for itself in dev; delete it with
// the upgrade. It must be the first setup file: `$app/env/private` copies each value out when it is
// first imported, and the next setup file imports it.

import { fileURLToPath } from 'node:url';
// @ts-expect-error -- SvelteKit's internal virtual module, which it declares no types for.
import { set_env } from '__sveltekit/env';
import { loadEnv } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

set_env(loadEnv(import.meta.env.MODE, REPO_ROOT, ''));
