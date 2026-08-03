import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Liveness probe. The hosting platform's healthcheck points here, and Playwright
 * waits on it before running e2e tests.
 */
export const GET: RequestHandler = () => json({ status: 'ok' });
