import { database, withDbErrorHandling } from '$lib/server/db';
import { requestCancellation } from '$lib/server/reports/cancel';
import { requireReportRouteContext } from '$lib/server/reports/route-context';
import type { RequestHandler } from './$types';

/** Cancel a running analysis. */
export const POST: RequestHandler = async (event) => {
  const { organizationId, reportId, actor } = await requireReportRouteContext(database(), event);

  await withDbErrorHandling(
    () => requestCancellation(database(), { organizationId, reportId, actor }),
    {
      action: 'cancel a report',
      context: { organizationId, reportId },
    },
  );

  return new Response(null, { status: 204 });
};
