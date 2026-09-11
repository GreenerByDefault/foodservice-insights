/** The auth + org-access prologue shared by every route scoped to an organization. */

import type { DatabaseExecutor, OrganizationId, ReportId, UserId } from '@gbd/db';
import { requireAuth, requireOrganizationAccess, requireOrganizationAdmin } from './guards.ts';
import type { Actor } from './types.ts';

/** The signed-in caller's identity and access to `event.params.organizationSlug`, or the 401/404
 * (or 403 with `admin: true`) a missing one produces. */
export async function requireOrganizationRouteContext(
  db: DatabaseExecutor,
  event: { params: { organizationSlug: string }; locals: App.Locals },
  options: { admin?: boolean } = {},
): Promise<{ organizationId: OrganizationId; actor: Actor }> {
  const auth = requireAuth(event.locals);
  const organizationSlug = event.params.organizationSlug;
  const access = options.admin
    ? await requireOrganizationAdmin(db, auth, organizationSlug)
    : await requireOrganizationAccess(db, auth, organizationSlug);

  // For a superadmin with no membership row, `access.role` is `'admin'` (see
  // `requireOrganizationAccess`), and so, deliberately, is what the audit row built from this
  // actor will say.
  return {
    organizationId: access.organizationId,
    actor: { userId: auth.user.id, role: access.role },
  };
}

/** Like `requireOrganizationRouteContext`, for a route scoped to a single report. */
export async function requireReportRouteContext(
  db: DatabaseExecutor,
  event: {
    params: { organizationSlug: string; reportId: string };
    locals: App.Locals;
  },
  options: { admin?: boolean } = {},
): Promise<{ organizationId: OrganizationId; reportId: ReportId; actor: Actor }> {
  const { organizationId, actor } = await requireOrganizationRouteContext(db, event, options);
  return { organizationId, reportId: event.params.reportId as ReportId, actor };
}

/** Like `requireOrganizationRouteContext`, for a route scoped to a single member. */
export async function requireMemberRouteContext(
  db: DatabaseExecutor,
  event: {
    params: { organizationSlug: string; userId: string };
    locals: App.Locals;
  },
  options: { admin?: boolean } = {},
): Promise<{ organizationId: OrganizationId; actor: Actor; targetUserId: UserId }> {
  const { organizationId, actor } = await requireOrganizationRouteContext(db, event, options);
  return { organizationId, actor, targetUserId: event.params.userId as UserId };
}
