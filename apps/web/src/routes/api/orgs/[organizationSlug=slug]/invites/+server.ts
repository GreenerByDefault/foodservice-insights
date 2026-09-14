/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Invite an address, or re-invite one that is already outstanding — which supersedes the pending
 * row and restarts its lifetime, because `organization_invite_one_pending_per_email` permits only
 * one. The email links to `/sign-in?email=...` and carries no token. Admin only, capped at
 * `HOURLY_INVITE_LIMIT` per hour for the inviting user.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
