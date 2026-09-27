/** Reading configuration inside the web app.
 *
 * This is the Vite-side counterpart to `requireEnv` from `@gbd/core/env`, which the web app must not
 * use: its config has to be read at runtime, so that one built artifact can run in any
 * environment.
 */

import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

/** Read a private environment variable, or fail with a pointer at the setup instructions. */
export function requirePrivateVar(name: string): string {
  return privateEnv[name] || missingVar(name);
}

/** `requirePrivateVar` for a `PUBLIC_` variable, which `$env/dynamic/private` does not carry. */
export function requirePublicVar(name: `PUBLIC_${string}`): string {
  return publicEnv[name] || missingVar(name);
}

function missingVar(name: string): never {
  throw new Error(
    `Must set the env var '${name}'. Copy .env.example to .env at the repo root and start the ` +
      'local stacks — see the README.',
  );
}
