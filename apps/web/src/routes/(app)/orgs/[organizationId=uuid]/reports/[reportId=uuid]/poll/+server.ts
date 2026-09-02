import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { pollIntervalMsForWorkerMode } from '$lib/polling/schedule';
import { database, withDbErrorHandling } from '$lib/server/db';
import { requireVar } from '$lib/server/env';
import { requireReportRouteContext } from '$lib/server/reports/route-context';
import { _loadReport } from '../+page.server.ts';
import type { RequestHandler } from './$types';

/** The report page's own reads after the first — not `/api`, and not a page `load`.
 *
 * Neither of those can serve them. `invalidate()` re-runs `load`, but when its data request fails
 * at the network level, `load` falls back to a full-page navigation — a reload we don't want —
 * and breaks the page outright if the connection itself is down (`README.md` § Routes). A plain
 * `fetch`, via `polling/poll-report.ts`, just rejects instead, which is what backing off and
 * staying on screen needs.
 */
export const GET: RequestHandler = async (event) => {
  const { organizationId, reportId } = requireReportRouteContext(event);

  // Same query as the page's own `load`, so a first request landing here directly gets the same
  // 404/500 shape.
  const data = await withDbErrorHandling(
    () =>
      _loadReport(database(), {
        organizationId,
        reportId,
        supportEmail: requireVar('EMAIL_SUPPORT_ADDRESS'),
        pollIntervalMs: pollIntervalMsForWorkerMode(env.WORKER_MODE),
      }),
    { action: 'poll a report', context: { organizationId, reportId } },
  );

  return json(data);
};
