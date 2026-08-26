/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Delete a report: soft-delete it, and in the same transaction record `cancel_requested_at` on an
 * attempt still pending or processing — REQUIREMENTS.md § Data deletion. That second half is the
 * whole of `cancel/+server.ts`, so the two endpoints share it.
 *
 * Never writes `analysis_attempt.status`; only a worker does. Guard the update with
 * `status in ('pending', 'processing')`: touching no rows means the attempt finished first, and the
 * report is soft-deleted either way. Which audit event to write follows from what it did.
 *
 * A member may delete their own report; an admin may delete any of the organization's.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
