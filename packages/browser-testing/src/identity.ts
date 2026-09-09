/** The one place a browser test's signed-in identity is materialized.
 *
 * `identifyUser` (`apps/web/src/lib/server/auth/identify.ts`) is a phase-one stand-in that
 * resolves every request to `PLACEHOLDER_USER_ID`, so a run has exactly one identity no matter
 * how many tests it has. `prepareRunIdentity` writes that row once, per run; `readRunIdentity` is
 * how a spec's fixture gets hold of it. When Supabase Auth lands, this file is where minting a
 * real user per test replaces both — nothing else in either suite refers to the placeholder.
 *
 * The organization is deliberately not here: the `org` fixture (`./fixtures.ts`) creates one per
 * test, so a seeded one would only turn up uninvited in every listing.
 */

import { type Database, initializeDatabase, shutdownDatabase, type UserId } from '@gbd/db';
import { PLACEHOLDER_USER_EMAIL, PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import type { Kysely } from 'kysely';

export type TestIdentity = {
  id: UserId;
  email: string;
};

/** Commit the run's identity into its own database, as `runAgainstFreshStack` does before
 * Playwright starts.
 *
 * `email` defaults to a fixed address, which is what keeps a screenshot of the account menu — it
 * renders the address — identical on every run. A suite that instead asserts on mail we sent has
 * to pass a unique one, because Mailpit is shared across concurrent runs and worktrees.
 */
export async function prepareRunIdentity(
  connectionString: string,
  email: string = PLACEHOLDER_USER_EMAIL,
): Promise<void> {
  const database = initializeDatabase({ connectionString });
  try {
    // The matching `app_user` row is written by the `on_auth_user_created` trigger, not here.
    await database.insertInto('auth.users').values({ id: PLACEHOLDER_USER_ID, email }).execute();
  } finally {
    await shutdownDatabase(database);
  }
}

export async function readRunIdentity(db: Kysely<Database>): Promise<TestIdentity> {
  const user = await db
    .selectFrom('auth.users')
    .select(['id', 'email'])
    .where('id', '=', PLACEHOLDER_USER_ID)
    .executeTakeFirstOrThrow();

  return { id: user.id as UserId, email: user.email as string };
}
