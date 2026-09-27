/** Which identity a request runs as, chosen per environment by `PUBLIC_AUTH_MODE`.
 *
 * - `placeholder`: every request is the one seeded user from `pnpm seed:identity`. No sign-in, no
 *   mail, and Supabase Auth is never contacted. How a hosted environment runs until there is an
 *   email provider, behind a site password.
 * - `supabase`: a request is whoever its Supabase Auth session cookie says it is.
 *
 * Required, with no default: defaulting to `placeholder` would serve a deploy that forgot the
 * variable to every visitor as one admin, and defaulting to `supabase` would 401 a developer whose
 * `.env` predates it with no hint why.
 *
 * `PUBLIC_`, because the browser branches on it too: it must not load supabase-js in
 * `placeholder`. Read here and nowhere else — components take what they need as a prop.
 */

import { env } from '$env/dynamic/public';

export type AuthMode = 'placeholder' | 'supabase';

const AUTH_MODES: readonly AuthMode[] = ['placeholder', 'supabase'];

export function parseAuthMode(raw: string | undefined): AuthMode {
  const mode = AUTH_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;
  throw new Error(
    `${raw ? `Unknown PUBLIC_AUTH_MODE '${raw}'` : 'PUBLIC_AUTH_MODE is not set'}. ` +
      `Expected one of: ${AUTH_MODES.join(', ')}. See .env.example.`,
  );
}

export function authMode(): AuthMode {
  return parseAuthMode(env.PUBLIC_AUTH_MODE);
}
