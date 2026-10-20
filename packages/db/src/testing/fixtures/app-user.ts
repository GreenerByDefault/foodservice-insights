import type { RawBuilder } from 'kysely';
import type { AppUser } from '../../generated/public/AppUser.ts';
import type { DatabaseExecutor } from '../../schema.ts';

export async function insertAppUser(
  database: DatabaseExecutor,
  overrides: {
    id?: string;
    displayName?: string;
    isSuperadmin?: boolean;
    country?: string;
    email?: string;
    /** Left out, null, as `auth.users` has no default for it. */
    createdAt?: Date | RawBuilder<Date>;
    /** When the user entered their sign-in code, which also makes it their last sign-in, as
     * entering one is signing in. Left out, both null: the address was never confirmed. */
    emailConfirmedAt?: Date | RawBuilder<Date>;
  } = {},
): Promise<AppUser> {
  const { id } = await database
    .insertInto('auth.users')
    .values({
      // Set by a caller mirroring a user that already exists in GoTrue, whose id the session's
      // JWT carries.
      id: (overrides.id ?? crypto.randomUUID()) as AppUser['id'],
      email: overrides.email ?? `${crypto.randomUUID()}@example.test`,
      createdAt: overrides.createdAt,
      emailConfirmedAt: overrides.emailConfirmedAt,
      lastSignInAt: overrides.emailConfirmedAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // The `app_user` row itself is written by the `on_auth_user_created` trigger, not by us.
  // These fields have to be set manually afterwards.
  if (
    overrides.displayName !== undefined ||
    overrides.isSuperadmin !== undefined ||
    overrides.country !== undefined
  ) {
    await database
      .updateTable('appUser')
      .set({
        ...(overrides.displayName !== undefined ? { displayName: overrides.displayName } : {}),
        ...(overrides.isSuperadmin !== undefined ? { isSuperadmin: overrides.isSuperadmin } : {}),
        ...(overrides.country !== undefined ? { country: overrides.country } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  return await database
    .selectFrom('appUser')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** `insertAppUser` for an address a test pins — one its committed screenshot renders — where a
 * second run of that test in the same database (`--repeat-each`) would otherwise violate
 * `users_email_partial_key`. The user is found instead, and `displayName` re-applied so the row
 * reads the same either way. Never deleted: like a pinned organization name, the row belongs to
 * the run, whose database is dropped wholesale afterwards.
 *
 * `ON CONFLICT DO NOTHING` untargeted, as the unique index on `auth.users.email` is partial and a
 * targeted clause would have to restate its predicate. */
export async function findOrInsertAppUser(
  database: DatabaseExecutor,
  user: { email: string; displayName?: string },
): Promise<AppUser> {
  await database
    .insertInto('auth.users')
    .values({ id: crypto.randomUUID() as AppUser['id'], email: user.email })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  const { id } = await database
    .selectFrom('auth.users')
    .select('id')
    .where('email', '=', user.email)
    .executeTakeFirstOrThrow();

  if (user.displayName !== undefined) {
    await database
      .updateTable('appUser')
      .set({ displayName: user.displayName })
      .where('id', '=', id)
      .execute();
  }

  return await database
    .selectFrom('appUser')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** `email` lives on `auth.users`, not the `app_user` row `insertAppUser` returns, so this reads
 * it back separately. */
export async function insertAppUserWithEmail(
  database: DatabaseExecutor,
): Promise<{ id: AppUser['id']; email: string }> {
  const user = await insertAppUser(database);
  const { email } = await database
    .selectFrom('auth.users')
    .select('email')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  return { id: user.id, email: email as string };
}
