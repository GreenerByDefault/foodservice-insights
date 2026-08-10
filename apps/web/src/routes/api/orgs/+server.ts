/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Insert the organization and the creator's admin row in one transaction, since
 * `organization_has_a_member` is deferred to commit and would otherwise refuse the organization.
 * The allowance of five is enforced by the trigger on `app_user.organizations_created_count`, so
 * counting here would only race. Notify GBD, and write the audit event.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
