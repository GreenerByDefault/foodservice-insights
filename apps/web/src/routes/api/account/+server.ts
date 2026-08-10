/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Rename yourself. Changing an email is not here: that is a browser-side Supabase call. */
export const PATCH: RequestHandler = () => error(501, { message: 'Not implemented yet' });

/** Delete your own account, for real. Needs the service-role key, so it cannot be a browser call.
 *
 * Deleting the `auth.users` row cascades to `app_user`; the reports the user submitted stay, with
 * `created_by_user_id` set to null, and the UI shows a deleted user as the submitter. The raw id
 * survives in `audit_event`, which has no foreign keys for exactly this reason.
 *
 * Refuse while the user is the last admin of any organization. Notify GBD.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
