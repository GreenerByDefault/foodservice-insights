/** **Stub:** every handler here answers 501 until its feature lands. */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Decline an invite. Same guard as accepting, separate audit action. */
export const POST: RequestHandler = () => error(501, { message: 'Not implemented yet' });
