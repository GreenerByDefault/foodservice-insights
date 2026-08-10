/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The upload: validate, store the file, write the rows, enqueue the first attempt. Answers 201
 * with a `location` header pointing at the new report.
 *
 * Authorize the organization *before* validating anything, because a file that fails validation is
 * still recorded — and `rejected_upload.organization_id` is `NOT NULL` with a foreign key, so there
 * is nowhere to write the rejection until the organization is known to be real and the caller's.
 *
 * The file arrives on this request rather than through a presigned URL: at a 10MB cap the server has
 * to read it to validate it anyway. Validate in full here, including the security scans, so the
 * worker can trust its input. Then `report`, `input_file` and the first `analysis_attempt` in one
 * transaction, with the object written before the rows that name it.
 */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
