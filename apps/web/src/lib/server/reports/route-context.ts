/** The auth + org-access prologue shared by every route under `reports/[reportId=uuid]/*`. */

import type { OrganizationId, ReportId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import type { Actor } from '$lib/server/auth/types';

/** The signed-in caller's identity and access, or the 401/404 a missing one produces. */
export function requireReportRouteContext(event: {
  params: { organizationId: string; reportId: string };
  locals: App.Locals;
}): { organizationId: OrganizationId; reportId: ReportId; actor: Actor } {
  const auth = requireAuth(event.locals);
  const organizationId = event.params.organizationId as OrganizationId;
  const reportId = event.params.reportId as ReportId;
  const access = requireOrganizationAccess(auth, organizationId);

  return { organizationId, reportId, actor: { userId: auth.user.id, role: access.role } };
}
