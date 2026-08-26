/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Retry: insert the next `analysis_attempt` and let a worker claim it. A retry is a new attempt,
 * never a mutation of the old one.
 *
 * Do not check first. A trigger already requires the latest attempt to be exactly `failed`, the
 * number to be one higher, and the report not to be deleted; a CHECK caps it at five, and a unique
 * partial index allows only one attempt in flight — so attempt the insert and map
 * `check_violation` and `unique_violation` to a 409. Checking beforehand would duplicate all five
 * rules and still race.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
