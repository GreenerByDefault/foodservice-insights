import type { DatabaseExecutor, OrganizationId, UserId } from '@gbd/db';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { checkReportRateLimit, describeRateLimitExceeded } from '$lib/server/reports/rate-limit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
  const { user } = requireAuth(locals);
  const { organization } = await parent();

  return await withDbErrorHandling(
    () => _loadRateLimitWarning(database(), { organizationId: organization.id, userId: user.id }),
    {
      action: 'check the report rate limit',
      context: { organizationId: organization.id, userId: user.id },
    },
  );
};

export async function _loadRateLimitWarning(
  db: DatabaseExecutor,
  params: { organizationId: OrganizationId; userId: UserId },
): Promise<{ rateLimitWarning: string | undefined }> {
  const exceeded = await checkReportRateLimit(db, params);
  return { rateLimitWarning: exceeded ? describeRateLimitExceeded(exceeded).summary : undefined };
}
