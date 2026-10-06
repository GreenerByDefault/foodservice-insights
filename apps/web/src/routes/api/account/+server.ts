import type { DatabaseExecutor, UserId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import * as v from 'valibot';
import { DisplayNameSchema } from '#lib/account/display-name.js';
import { requireAuth } from '#lib/server/auth/guards.js';
import { parseBody } from '#lib/server/body.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import type { RequestHandler } from './$types';

/** Rename yourself. Changing an email is not here: that is a browser-side Supabase call. */
export const PATCH: RequestHandler = async (event) => {
  const { user } = requireAuth(event.locals);
  const body = await event.request.json();
  return await _renameSelf(database(), user.id, body);
};

/** **Stub:** answers 501 until its feature lands.
 *
 * Hard delete your own account.
 *
 * Deleting the `auth.users` row cascades to `app_user`; the reports the user submitted stay, with
 * `created_by_user_id` set to null, and the UI shows a deleted user as the submitter. The raw id
 * survives in `audit_event`, which has no foreign keys for exactly this reason.
 *
 * Refuse while the user is the last admin of any organization. Notify GBD.
 */
export const DELETE: RequestHandler = () => error(501, 'Not implemented yet');

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
