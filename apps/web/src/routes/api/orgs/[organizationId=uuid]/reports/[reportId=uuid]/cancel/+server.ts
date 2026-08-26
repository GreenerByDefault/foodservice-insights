/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Cancel a running analysis: record `cancel_requested_at` on the report's attempt, guarded on
 * `status in ('pending', 'processing')`. Never writes `analysis_attempt.status`; a worker converges
 * the request. Unlike `DELETE ../+server.ts`, the report is not soft-deleted.
 *
 * Zero rows means the attempt finished first, so the cancel did nothing: answer 409 rather than
 * reporting a success that did not happen.
 *
 * Same permission as deleting the report.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
