import { parseCspReport } from '#lib/server/csp-report.js';
import { logger } from '#lib/server/log.js';
import type { RequestHandler } from './$types';

/** A browser's report is a few hundred bytes, and Chromium's batches stay well under this. */
const MAX_BODY_BYTES = 64 * 1024;

/** Where browsers report a page breaking its Content-Security-Policy: `report-uri` and
 * `report-to` in `kit.csp`. Unauthenticated, as every browser sends it.
 *
 * *Rejected: rate-limiting it.* Every unauthenticated URL already costs an access line, and a
 * report at most doubles that; the host's edge is the layer for floods (REQUIREMENTS § Abuse
 * limits).
 * *Rejected: a hosted collector such as report-uri.com,* a new vendor for what a log line does. */
export async function _reportViolations(request: Request): Promise<Response> {
  // SvelteKit fails a body that runs past its `content-length`, so the header can be trusted.
  const declaredLength = request.headers.get('content-length');
  if (declaredLength === null || !(Number(declaredLength) <= MAX_BODY_BYTES)) {
    return new Response(null, { status: 413 });
  }

  const violations = parseCspReport(request.headers.get('content-type'), await request.text());
  if (violations === null) return new Response(null, { status: 400 });

  for (const violation of violations) logger().warn(violation, 'CSP violation');
  return new Response(null, { status: 204 });
}

export const POST: RequestHandler = ({ request }) => _reportViolations(request);
