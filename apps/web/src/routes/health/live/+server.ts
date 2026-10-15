import type { RequestHandler } from './$types';

/** Liveness probe: the host restarts an instance that fails it. It touches no dependency, so only a
 * wedged process fails it; `/health/ready` reports on the database and the bucket. */
export const GET: RequestHandler = () => Response.json({ status: 'ok' });
