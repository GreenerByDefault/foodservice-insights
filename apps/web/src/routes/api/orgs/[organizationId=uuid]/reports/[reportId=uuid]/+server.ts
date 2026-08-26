/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Delete a report, which is also how a running one is canceled — REQUIREMENTS.md defines cancel as
 * a soft delete wearing a different label, and a plain delete would have to stop a live attempt
 * anyway. So one endpoint does both: soft-delete the report, and in the same transaction record a
 * cancel *request* — `cancel_requested_at` — on any attempt still pending or processing. This
 * endpoint never writes `analysis_attempt.status`, for either status: after insert, only a worker
 * does, which keeps the state machine in one place. A worker turns the request into the terminal
 * `canceled`, which costs up to the queue's reap interval for an unclaimed attempt — invisible,
 * since the report is soft-deleted immediately.
 *
 * Guard that update with `status in ('pending', 'processing')`. Nothing is wrong if it touches no
 * rows; it means the attempt finished first, and the report is soft-deleted either way. Which audit
 * event to write follows from what the update actually did.
 *
 * A member may delete their own report; an admin may delete any of the organization's.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
