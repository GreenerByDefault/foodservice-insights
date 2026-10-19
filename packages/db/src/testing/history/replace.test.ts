import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import { insertReportWithAttempt } from '../fixtures/analysis-attempt.ts';
import { withRollback } from '../transactions.ts';
import { SYNTHETIC_EMAIL_DOMAIN, SYNTHETIC_SLUG_PREFIX } from './insert.ts';
import { planSyntheticHistory, SYNTHETIC_HISTORY_SEED } from './plan.ts';
import { replaceSyntheticHistory } from './replace.ts';

describe('replaceSyntheticHistory', () => {
  test('run twice, leaves one history, no tombstones of the first, and rows it did not make', async () => {
    // Enough for every kind of tombstone. The whole history, written twice, ran past the 5s
    // timeout in CI.
    const { organizations, unconfirmedUsers } = planSyntheticHistory(SYNTHETIC_HISTORY_SEED);
    const plan = {
      organizations: organizations
        .slice(0, 1)
        .map((organization) => ({ ...organization, reports: organization.reports.slice(0, 1) })),
      unconfirmedUsers: unconfirmedUsers.slice(0, 1),
    };

    const counts = await withRollback(DATABASE, async (transaction) => {
      const unmarked = await insertReportWithAttempt(transaction, { status: 'succeeded' });
      const first = await replaceSyntheticHistory(transaction, plan);
      const firstReportIds = (
        await transaction
          .selectFrom('report')
          .select('id')
          .where('organizationId', 'in', first.organizationIds)
          .execute()
      ).map(({ id }) => id);

      await replaceSyntheticHistory(transaction, plan);

      const { rows } = await sql<Record<string, number>>`
        SELECT
          (SELECT count(*)::int FROM organization WHERE slug LIKE ${`${SYNTHETIC_SLUG_PREFIX}%`})
            AS organizations,
          (SELECT count(*)::int FROM auth.users WHERE email LIKE ${`%@${SYNTHETIC_EMAIL_DOMAIN}`})
            AS users,
          (SELECT count(*)::int FROM metrics.purged_report WHERE id = ANY(${firstReportIds}::uuid[]))
            + (SELECT count(*)::int FROM metrics.purged_attempt WHERE report_id = ANY(${firstReportIds}::uuid[]))
            + (SELECT count(*)::int FROM metrics.purged_user WHERE id = ANY(${first.userIds}::uuid[]))
            AS "firstHistoryTombstones",
          (SELECT count(*)::int FROM analysis_attempt WHERE id = ${unmarked.attempt.id})
            AS "unmarkedAttempts"
      `.execute(transaction);
      return rows[0];
    });

    expect(counts).toEqual({
      organizations: plan.organizations.length,
      users:
        plan.organizations.reduce((sum, { members }) => sum + 1 + members.length, 0) +
        plan.unconfirmedUsers.length,
      firstHistoryTombstones: 0,
      unmarkedAttempts: 1,
    });
  });
});
