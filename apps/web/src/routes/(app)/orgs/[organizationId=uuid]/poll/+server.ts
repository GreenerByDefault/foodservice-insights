import type { OrganizationId } from '@gbd/db';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { pollIntervalMsForWorkerMode } from '$lib/polling/schedule';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { _loadReports } from '../+page.server.ts';
import { parseCursor } from '../pagination.ts';
import type { RequestHandler } from './$types';

/** The list's own reads after the first — see `reports/[reportId=uuid]/poll/+server.ts`'s doc
 * comment for why this is a plain endpoint rather than `invalidate()`.
 *
 * `requireReportRouteContext` is typed for a `reportId` this route doesn't have, so the
 * auth + org-access prologue is inlined here instead. */
export const GET: RequestHandler = async (event) => {
  const organizationId = event.params.organizationId as OrganizationId;
  requireOrganizationAccess(requireAuth(event.locals), organizationId);
  const cursor = parseCursor(event.url.searchParams);

  // Same query as the page's own `load`, so a first request landing here directly gets the same
  // 404/500 shape.
  const data = await withDbErrorHandling(
    () =>
      _loadReports(database(), {
        organizationId,
        cursor,
        pollIntervalMs: pollIntervalMsForWorkerMode(env.WORKER_MODE),
      }),
    { action: 'poll the reports list', context: { organizationId } },
  );

  return json(data);
};
