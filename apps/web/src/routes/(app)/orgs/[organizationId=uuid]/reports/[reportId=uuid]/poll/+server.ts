import { json } from '@sveltejs/kit';
import { database, withDbErrorHandling } from '$lib/server/db';
import { requireVar } from '$lib/server/env';
import { requireReportRouteContext } from '$lib/server/reports/route-context';
import { _loadReport } from '../+page.server.ts';
import type { RequestHandler } from './$types';

/** The report page's own reads after the first — not `/api`, and not a page `load`. Neither can
 * serve them: `invalidate()` re-running `load` falls back to a full-page navigation when its own
 * data request fails at the network level, which is a reload we don't want, and breaks the page
 * outright if the connection is the thing that's down (`README.md` § Routes). A plain `fetch`, via
 * `polling/poll-report.ts`, genuinely rejects instead — which is what backing off and staying on
 * screen needs.
 *
 * That applies to *every* refresh on this page, not just the timed one. Cancel and retry route
 * through the same poll rather than `invalidate()`, so a flaky connection can't destroy the page
 * out from under a user who has just successfully cancelled — and so the page has one writer of
 * its own state (see `polling/view.svelte`).
 *
 * Same query as the page's own `load`, so the same 404/500 shape applies to a first request that
 * lands here directly.
 */
export const GET: RequestHandler = async (event) => {
  const { organizationId, reportId } = requireReportRouteContext(event);

  const data = await withDbErrorHandling(
    () =>
      _loadReport(database(), {
        organizationId,
        reportId,
        supportEmail: requireVar('EMAIL_SUPPORT_ADDRESS'),
      }),
    { action: 'poll a report', context: { organizationId, reportId } },
  );

  return json(data);
};
