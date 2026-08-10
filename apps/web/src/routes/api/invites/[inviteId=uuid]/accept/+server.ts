/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Accept an invite, joining the organization with the role it names.
 *
 * Not under `/api/orgs/[organizationId]` like the rest, deliberately: the caller is not a member
 * yet, so an organization-scoped path would promise a guard that could never pass. The guard here is
 * that the invite's email matches the caller's verified one — which is what makes forwarding the
 * email useless.
 *
 * Refuse an invite already past `expires_at`, and write the `expired` status while refusing it.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
