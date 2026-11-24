import type { DatabaseExecutor } from '@gbd/db';
import { requireAuth } from '#lib/server/auth/guards.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import {
  checkReportRateLimit,
  describeRateLimitExceeded,
  type ReportCreator,
} from '#lib/server/reports/rate-limit.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
  const { user } = requireAuth(locals);
  const { organization } = await parent();

  return await _loadRateLimitWarning(database(), {
    organizationId: organization.id,
    userId: user.id,
    isSuperadmin: user.isSuperadmin,
  });
};

export async function _loadRateLimitWarning(
  db: DatabaseExecutor,
  params: ReportCreator,
): Promise<{ rateLimitWarning: string | undefined }> {
  return await withDbErrorHandling(
    async () => {
      const exceeded = await checkReportRateLimit(db, params);
      return {
        rateLimitWarning: exceeded ? describeRateLimitExceeded(exceeded).summary : undefined,
      };
    },
    {
      action: 'check the report rate limit',
      context: { organizationId: params.organizationId, userId: params.userId },
    },
  );
}
