/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Promote or demote. Admin only. */
export const PATCH: RequestHandler = () => error(501, { message: 'Not implemented yet' });

/** Remove a member, or leave — the same request with your own id, which is why this is not two
 * endpoints. An admin may do either; a member may only do the second.
 *
 * `organization_member_at_least_one_admin` is deferred and takes a row lock, so it, not this
 * handler, decides whether the last admin may go. Turn its `check_violation` into a 409.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
