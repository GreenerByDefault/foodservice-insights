/** The one place a browser test's signed-in identity is materialized.
 *
 * Every test mints a GoTrue user of its own and signs its browser in with a real session
 * (`mintUser`, `signInCookies`). Screenshots that render the signed-in user's address use the run's
 * *pinned* identity instead (`preparePinnedIdentity`, `readPinnedIdentity`).
 *
 * **GoTrue and the app read different databases.** GoTrue writes users into the stack's main
 * `postgres`; the app under test reads a per-run clone (`@gbd/db/testing`'s `createRunDatabase`),
 * where `loadAuthorization` looks the session's user up. So every GoTrue user minted here is also
 * mirrored into the run database under the same id, which fires `on_auth_user_created` there as
 * a real sign-up would. The mirror's address need not match GoTrue's — that is how the pinned
 * identity shows a fixed address while signing in with one unique to the run.
 *
 * Sessions come from a password sign-in, not an emailed code: every password sign-in is its own
 * session, so any number of concurrent tests can be one user, where GoTrue keeps one outstanding
 * code per user and a second request cancels the first. No real user has a password.
 */

import { AUTH_COOKIE_NAME } from '@gbd/core';
import { requireEnv } from '@gbd/core/env';
import { type Database, initializeDatabase, shutdownDatabase, type UserId } from '@gbd/db';
import { insertAppUser } from '@gbd/db/testing';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Kysely } from 'kysely';

export type TestIdentity = {
  id: UserId;
  email: string;
};

/** Every GoTrue user the suites mint lives at this domain, and only they do, which is what lets
 * `sweepStaleGoTrueUsers` delete by it. Under `.test`, so no mail to one can reach a real inbox. */
export const GOTRUE_TEST_DOMAIN = 'gotrue.example.test';

/** The address the pinned identity shows. Only the run database has it; see the file header. */
export const PINNED_IDENTITY_EMAIL = 'sam.cook@example.test';

/** Every minted user's display name, the pinned identity's included, unless it is minted with
 * `onboarded: false`. One fixed name, so a screenshot's monogram is the same whoever the test is. */
export const MINTED_USER_DISPLAY_NAME = 'Sam Cook';

const TEST_USER_PASSWORD = 'test-user-password';

/** A GoTrue user, mirrored into the run database. */
export type MintedUser = TestIdentity & {
  /** GoTrue's address for the user, which is what signs in. Differs from `email` only for the
   * pinned identity. */
  signInEmail: string;
};

/** Mint a GoTrue user and mirror it into `db`, the run database.
 *
 * `signInEmail` defaults to a fresh address at `GOTRUE_TEST_DOMAIN`; `email`, the address the app
 * shows, defaults to the same. `onboarded: false` leaves the display name unset, as a sign-up does,
 * so the app asks the user for one before rendering any page inside `(app)`.
 */
export async function mintUser(
  db: Kysely<Database>,
  options: { signInEmail?: string; email?: string; onboarded?: boolean } = {},
): Promise<MintedUser> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email: options.signInEmail ?? `${crypto.randomUUID()}@${GOTRUE_TEST_DOMAIN}`,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;

  // GoTrue's copy, not ours: it lowercases the address.
  const signInEmail = data.user.email;
  if (signInEmail === undefined) throw new Error('GoTrue created a user with no email');
  const email = options.email ?? signInEmail;
  const displayName = options.onboarded === false ? undefined : MINTED_USER_DISPLAY_NAME;
  await insertAppUser(db, { id: data.user.id, email, displayName });

  return { id: data.user.id as UserId, email, signInEmail };
}

/** Best-effort, like every other cleanup in the harness: `sweepStaleGoTrueUsers` is the backstop.
 *
 * GoTrue's copy only. The run database's mirror stays until the database is dropped: deleting it
 * would cascade to the user's memberships, and `organization_member_at_least_one_admin` refuses
 * to remove the last admin of an organization that outlives the test, as a pinned `orgName`
 * does. */
export async function deleteGoTrueUser(id: UserId): Promise<void> {
  const { error } = await adminClient().auth.admin.deleteUser(id);
  if (error) console.warn(`identity: could not delete GoTrue user ${id}`, error);
}

/** GoTrue's address for a user, which a change of email writes and the run database never sees
 * (see the file header). */
export async function readGoTrueEmail(id: UserId): Promise<string | undefined> {
  const { data, error } = await adminClient().auth.admin.getUserById(id);
  if (error) throw error;
  return data.user.email;
}

/** The address the pinned identity signs in with: unique to the run, so nothing is shared across
 * runs or worktrees, and derived from `TEST_RUN_ID` so the fixtures can find it again. */
function pinnedSignInEmail(runName: string): string {
  return `pinned-${runName}@${GOTRUE_TEST_DOMAIN}`;
}

/** Mint the run's pinned identity, as `runAgainstFreshStack` does before Playwright starts.
 * Returns its id, for deleting afterwards. */
export async function preparePinnedIdentity(
  connectionString: string,
  runName: string,
): Promise<UserId> {
  const database = initializeDatabase({
    connectionString,
    log: 'console',
    siteUrl: process.env.SITE_URL,
  });
  try {
    const user = await mintUser(database, {
      signInEmail: pinnedSignInEmail(runName),
      email: PINNED_IDENTITY_EMAIL,
    });
    return user.id;
  } finally {
    await shutdownDatabase(database);
  }
}

export async function readPinnedIdentity(db: Kysely<Database>): Promise<MintedUser> {
  const user = await db
    .selectFrom('auth.users')
    .select('id')
    .where('email', '=', PINNED_IDENTITY_EMAIL)
    .executeTakeFirstOrThrow();

  return {
    id: user.id as UserId,
    email: PINNED_IDENTITY_EMAIL,
    signInEmail: pinnedSignInEmail(requireEnv('TEST_RUN_ID')),
  };
}

/** Sign in as `signInEmail` and return the session cookies, exactly as the app's own server
 * client would have written them — chunked, encoded, and under `AUTH_COOKIE_NAME`. */
export async function signInCookies(
  signInEmail: string,
): Promise<{ name: string; value: string }[]> {
  const cookieJar = new Map<string, string>();
  const client = createServerClient(
    requireEnv('PUBLIC_SUPABASE_URL'),
    requireEnv('PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          // An empty value is a deletion: `@supabase/ssr` clears stale chunks that way.
          for (const { name, value } of cookies) {
            if (value === '') cookieJar.delete(name);
            else cookieJar.set(name, value);
          }
        },
      },
    },
  );

  const { error } = await client.auth.signInWithPassword({
    email: signInEmail,
    password: TEST_USER_PASSWORD,
  });
  if (error) throw error;
  if (cookieJar.size === 0) throw new Error(`Signing in as ${signInEmail} wrote no session cookie`);

  return [...cookieJar].map(([name, value]) => ({ name, value }));
}

function adminClient(): SupabaseClient {
  return createClient(requireEnv('PUBLIC_SUPABASE_URL'), requireEnv('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
