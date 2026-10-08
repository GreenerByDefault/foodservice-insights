import type { DatabaseExecutor, UserId } from '@gbd/db';
import * as v from 'valibot';
import { DisplayNameSchema } from '#lib/account/display-name.js';
import { recordAuditEvent } from '#lib/server/audit.js';
import { requireAuth } from '#lib/server/auth/guards.js';
import type { AuthenticatedUser } from '#lib/server/auth/types.js';
import { parseBody } from '#lib/server/body.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import { notifyGbd } from '#lib/server/email.js';
import { attemptMemberWrite, lastAdminResponse } from '#lib/server/orgs/members.js';
import type { RequestHandler } from './$types';

/** Rename yourself. Changing an email is not here: that is a browser-side Supabase call. */
export const PATCH: RequestHandler = async (event) => {
  const { user } = requireAuth(event.locals);
  const body = await event.request.json();
  return await _renameSelf(database(), user.id, body);
};

/** Hard delete your own account. */
export const DELETE: RequestHandler = async (event) => {
  const { user } = requireAuth(event.locals);
  return await _deleteAccount(database(), { user });
};

/** Set `userId`'s display name. 400 for an invalid one, 204 on success. */
export async function _renameSelf(
  db: DatabaseExecutor,
  userId: UserId,
  body: unknown,
): Promise<Response> {
  const parsed = parseBody(v.object({ displayName: DisplayNameSchema }), body);
  if (!parsed.ok) return parsed.response;
  const { displayName } = parsed.value;

  await withDbErrorHandling(
    () => db.updateTable('appUser').set({ displayName }).where('id', '=', userId).execute(),
    { action: 'rename a user', context: { userId } },
  );

  return new Response(null, { status: 204 });
}

/** Delete `user`'s `auth.users` row, which cascades to `app_user` and their memberships. Their
 * reports stay, with a null creator; the raw id survives in `audit_event`, which has no foreign
 * keys for exactly this reason.
 *
 * Deleted here, in our own transaction, rather than through GoTrue's admin API, so the audit row
 * and the delete commit together — and the at-least-one-admin trigger, firing on the cascade,
 * rolls both back for an organization's only admin: 409 `last-admin`. GoTrue's own tables
 * (sessions, identities, one-time tokens) all cascade from `auth.users` too. 204 on success.
 */
export async function _deleteAccount(
  db: DatabaseExecutor,
  params: { user: Pick<AuthenticatedUser, 'id' | 'email'> },
): Promise<Response> {
  const { user } = params;

  const outcome = await withDbErrorHandling(
    () =>
      attemptMemberWrite(db, async (transaction) => {
        await recordAuditEvent(transaction, {
          action: 'user.deleted',
          actor: { userId: user.id },
          target: { type: 'user', id: user.id, organizationId: null },
        });
        await transaction.deleteFrom('auth.users').where('id', '=', user.id).execute();
      }),
    { action: 'delete an account', context: { userId: user.id } },
  );
  if (outcome === 'last-admin') return lastAdminResponse();

  await notifyGbd({ kind: 'gbd-user-deleted', userEmail: user.email });

  return new Response(null, { status: 204 });
}
