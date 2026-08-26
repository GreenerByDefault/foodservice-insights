import type { OrganizationId, ReportId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { requestCancellation } from '$lib/server/reports/cancel';
import type { RequestHandler } from './$types';

/** Cancel a running analysis. */
export const POST: RequestHandler = async ({ params, locals }) => {
  const auth = requireAuth(locals);
  const organizationId = params.organizationId as OrganizationId;
  const reportId = params.reportId as ReportId;
  const access = requireOrganizationAccess(auth, organizationId);

  await withDbErrorHandling(
    () =>
      requestCancellation(database(), {
        organizationId,
        reportId,
        actor: { userId: auth.user.id, role: access.role },
      }),
    { action: 'cancel a report', context: { organizationId, reportId } },
  );

  return new Response(null, { status: 204 });
};
