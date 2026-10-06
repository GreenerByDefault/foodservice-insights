/** Reading configuration inside the web app.
 *
 * This is the Vite-side counterpart to `requireEnv` from `@gbd/core/env`, which the web app must not
 * use: its config has to be read at runtime, so that one built artifact can run in any
 * environment.
 */

import * as privateEnv from '$app/env/private';
import * as publicEnv from '$app/env/public';

/** Read a private environment variable, or fail with a pointer at the setup instructions. */
export function requirePrivateVar(name: keyof typeof privateEnv): string {
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: server-only, and every dynamic variable is read at runtime anyway, so there is nothing to tree-shake.
  return privateEnv[name] || missingVar(name);
}

/** `requirePrivateVar` for a `PUBLIC_` variable, which `$app/env/private` does not carry. */
export function requirePublicVar(name: keyof typeof publicEnv): string {
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: server-only, and every dynamic variable is read at runtime anyway, so there is nothing to tree-shake.
  return publicEnv[name] || missingVar(name);
}

function missingVar(name: string): never {
  throw new Error(
    `Must set the env var '${name}'. Copy .env.example to .env at the repo root and start the ` +
      'local stacks — see the README.',
  );
}
