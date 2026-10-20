import type { InsertObject } from 'kysely';
import type { NewAnalysisAttemptLlmUsage } from '../../generated/public/AnalysisAttemptLlmUsage.ts';
import type { NewAnalysisAttemptQualityCheck } from '../../generated/public/AnalysisAttemptQualityCheck.ts';
import type { Database, DatabaseExecutor } from '../../schema.ts';
import { withTransaction } from '../../transactions.ts';
import type { OrganizationId, UserId } from '../../types.ts';
import { insertAnalysisAttempt } from '../fixtures/analysis-attempt.ts';
import { insertAppUser } from '../fixtures/app-user.ts';
import { insertOrganization, insertOrganizationMember } from '../fixtures/organization.ts';
import { insertReport } from '../fixtures/report.ts';
import { dbMsAgo } from '../fixtures/values.ts';
import {
  type PlannedOrganization,
  type PlannedUser,
  planSyntheticHistory,
  SYNTHETIC_HISTORY_SEED,
  type SyntheticHistoryPlan,
} from './plan.ts';

/** Every synthetic organization's slug starts with this, and every synthetic user's address ends
 * with the domain, which is how `replaceSyntheticHistory` finds them and nothing else. Nobody else
 * is a member of a synthetic organization, so the app shows them only on a superadmin's list. */
export const SYNTHETIC_SLUG_PREFIX = 'synthetic-history-';
export const SYNTHETIC_EMAIL_DOMAIN = 'synthetic-history.example.test';

export type InsertedSyntheticHistory = {
  organizationIds: OrganizationId[];
  userIds: UserId[];
};

/** Write the synthetic history, in one transaction, since the fixtures add the rows the schema
 * requires at `COMMIT`. Slugs, names and addresses carry a random run id, since each has to be
 * unique and tests run concurrently against one database. */
export async function insertSyntheticHistory(
  database: DatabaseExecutor,
  plan: SyntheticHistoryPlan = planSyntheticHistory(SYNTHETIC_HISTORY_SEED),
): Promise<InsertedSyntheticHistory> {
  return await withTransaction(database, (transaction) => writeHistory(transaction, plan));
}

async function writeHistory(
  database: DatabaseExecutor,
  plan: SyntheticHistoryPlan,
): Promise<InsertedSyntheticHistory> {
  const runId = crypto.randomUUID().slice(0, 8);
  let userCount = 0;
  const userIds: UserId[] = [];
  // Written at the end, a statement per table, rather than three per attempt.
  const telemetry: InsertObject<Database, 'analysisAttemptTelemetry'>[] = [];
  const llmUsage: NewAnalysisAttemptLlmUsage[] = [];
  const qualityChecks: NewAnalysisAttemptQualityCheck[] = [];

  async function insertUser(user: PlannedUser): Promise<UserId> {
    const { id } = await insertAppUser(database, {
      email: `${runId}-${userCount++}@${SYNTHETIC_EMAIL_DOMAIN}`,
      createdAt: dbMsAgo(user.createdMsAgo),
      ...(user.emailConfirmedMsAgo !== null && {
        emailConfirmedAt: dbMsAgo(user.emailConfirmedMsAgo),
      }),
    });
    userIds.push(id);
    return id;
  }

  async function insertOrganizationHistory(
    planned: PlannedOrganization,
    index: number,
  ): Promise<OrganizationId> {
    const adminId = await insertUser(planned.admin);
    const { organization } = await insertOrganization(database, {
      name: `${planned.name} (synthetic ${runId})`,
      slug: `${SYNTHETIC_SLUG_PREFIX}${runId}-${index}`,
      adminUserId: adminId,
      createdAt: dbMsAgo(planned.createdMsAgo),
    });
    for (const member of planned.members) {
      await insertOrganizationMember(database, {
        organizationId: organization.id,
        userId: await insertUser(member),
      });
    }

    for (const plannedReport of planned.reports) {
      const report = await insertReport(database, {
        organizationId: organization.id,
        createdByUserId: adminId,
        createdAt: dbMsAgo(plannedReport.createdMsAgo),
        countsBasis: plannedReport.countsBasis,
        ...(plannedReport.countsBasis === null && { monthlyCounts: null }),
      });
      for (const [position, attempt] of plannedReport.attempts.entries()) {
        const { id } = await insertAnalysisAttempt(database, {
          reportId: report.id,
          attemptNumber: position + 1,
          status: attempt.status,
          requestedByUserId: adminId,
          createdAt: dbMsAgo(attempt.createdMsAgo),
          finishedAt: dbMsAgo(attempt.finishedMsAgo),
          ...(attempt.status === 'canceled'
            ? { cancelRequestedAt: dbMsAgo(attempt.finishedMsAgo) }
            : {
                claimedAt: dbMsAgo(attempt.claimedMsAgo),
                notificationEmailSentAt: dbMsAgo(attempt.notifiedMsAgo),
              }),
          ...(attempt.status === 'failed' && { failureReason: attempt.failureReason }),
        });
        if (attempt.status === 'canceled') continue;
        telemetry.push({
          analysisAttemptId: id,
          reportId: report.id,
          organizationId: organization.id,
          countsBasis: plannedReport.countsBasis,
          recordedAt: dbMsAgo(attempt.finishedMsAgo),
          ...attempt.telemetry.row,
        });
        llmUsage.push(
          ...attempt.telemetry.llmUsage.map((row) => ({ ...row, analysisAttemptId: id })),
        );
        qualityChecks.push(
          ...attempt.telemetry.qualityChecks.map((row) => ({ ...row, analysisAttemptId: id })),
        );
      }
    }
    return organization.id;
  }

  // In sequence: every write goes through one connection, and a transaction's statements cannot
  // overlap on it.
  const organizationIds: OrganizationId[] = [];
  for (const [index, organization] of plan.organizations.entries()) {
    organizationIds.push(await insertOrganizationHistory(organization, index));
  }
  for (const user of plan.unconfirmedUsers) await insertUser(user);

  // Usage and quality rows reference their telemetry row, so it goes first.
  if (telemetry.length > 0) {
    await database.insertInto('analysisAttemptTelemetry').values(telemetry).execute();
  }
  if (llmUsage.length > 0) {
    await database.insertInto('analysisAttemptLlmUsage').values(llmUsage).execute();
  }
  if (qualityChecks.length > 0) {
    await database.insertInto('analysisAttemptQualityCheck').values(qualityChecks).execute();
  }

  return { organizationIds, userIds };
}
