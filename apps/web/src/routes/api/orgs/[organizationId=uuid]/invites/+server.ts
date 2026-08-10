/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Invite an address, or re-invite one that is already outstanding — which supersedes the pending
 * row and starts the fourteen days again, because `organization_invite_one_pending_per_email`
 * permits only one. The email links to `/sign-in?email=...` and carries no token. Admin only,
 * capped at five an hour for the organization.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
