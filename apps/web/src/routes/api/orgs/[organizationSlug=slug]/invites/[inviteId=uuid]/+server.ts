/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Revoke a pending invite. Admin only. */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });
