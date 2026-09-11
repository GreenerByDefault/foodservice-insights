/** The write shared by every route that can leave an organization with no admin, and the 409
 * both answer with when it would.
 *
 * `organization_member_at_least_one_admin` (REQUIREMENTS.md § Roles: an organization always has
 * one admin) is declared `DEFERRABLE INITIALLY DEFERRED`, so by default it fires at `COMMIT` —
 * too late for a caller inside the transaction to catch. `SET CONSTRAINTS … IMMEDIATE` moves the
 * check onto the write itself, so `attemptMemberWrite` can catch it here, and so it actually
 * fires when a test runs the same code inside `withRollback`, which never commits.
 */

import { type Database, type DatabaseExecutor, withTransaction } from '@gbd/db';
import { json } from '@sveltejs/kit';
import { sql, type Transaction } from 'kysely';
import { isCheckViolation } from '$lib/server/db';

const ORGANIZATION_MEMBER_AT_LEAST_ONE_ADMIN = 'organization_member_at_least_one_admin';

/** Runs `write` with the constraint checked immediately, inside its own transaction, classifying
 * a violation as `'last-admin'` rather than letting it escape as an opaque database failure.
 * Anything else `write` throws — including the `HttpError` a 404 raises — passes back out
 * untouched.
 */
export async function attemptMemberWrite(
  db: DatabaseExecutor,
  write: (transaction: Transaction<Database>) => Promise<void>,
): Promise<'done' | 'last-admin'> {
  return await withTransaction(db, async (transaction) => {
    await sql`SET CONSTRAINTS ${sql.raw(ORGANIZATION_MEMBER_AT_LEAST_ONE_ADMIN)} IMMEDIATE`.execute(
      transaction,
    );

    try {
      await write(transaction);
    } catch (cause) {
      if (isCheckViolation(cause, ORGANIZATION_MEMBER_AT_LEAST_ONE_ADMIN)) return 'last-admin';
      throw cause;
    }

    return 'done';
  });
}

/** The 409 for a write that would leave the organization with no admin. */
export function lastAdminResponse(): Response {
  return json(
    {
      message: "You're the only admin. Make someone else an admin first.",
      code: 'last-admin',
    },
    { status: 409 },
  );
}
