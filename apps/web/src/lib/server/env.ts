/** Reading configuration inside the web app.
 *
 * This is the Vite-side counterpart to `requireEnv` from `@gbd/core/env`, which the web app must not
 * use: its config has to be read at runtime, so that one built artifact can run in any
 * environment.
 */

import { env } from '$env/dynamic/private';

/** Read an environment variable, or fail with a pointer at the setup instructions. */
export function requireVar(name: string): string {
  const value = env[name];
  if (value) return value;
  throw new Error(
    `Must set the env var '${name}'. Copy .env.example to .env at the repo root and start the ` +
      'local stacks — see the README.',
  );
}
