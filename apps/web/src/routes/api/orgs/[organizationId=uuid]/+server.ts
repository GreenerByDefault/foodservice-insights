/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Rename the organization. Admin only. */
export const PATCH: RequestHandler = () => error(501, { message: 'Not implemented yet' });

/** Delete the organization, for real: its reports and attempts cascade, and its files go with one
 * `deletePrefix` over `organizationPrefix(id)` — the reason every key an organization owns sits
 * under a single prefix. User accounts are untouched. Admin only. Notify GBD, and audit it.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
