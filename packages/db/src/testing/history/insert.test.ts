import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import type { Database } from '../../schema.ts';
import { checkDeferredConstraints, withRollback } from '../transactions.ts';
import { type InsertedSyntheticHistory, insertSyntheticHistory } from './insert.ts';
import {
  type PlannedAttempt,
  planSyntheticHistory,
  SYNTHETIC_HISTORY_SEED,
  type SyntheticHistoryPlan,
} from './plan.ts';
import type { PlannedLlmUsage, PlannedQualityCheck, PlannedTelemetryRow } from './telemetry.ts';

type UserRow = {
  createdMsAgo: number;
  emailConfirmedMsAgo: number | null;
  lastSignInMsAgo: number | null;
  country: string | null;
};
type OrganizationRow = { createdMsAgo: number; members: number };
type AttemptRow = {
  attemptNumber: number;
  status: string;
  failureReason: string | null;
  createdMsAgo: number;
  claimedMsAgo: number | null;
  finishedMsAgo: number;
  notifiedMsAgo: number | null;
  hasRequester: boolean;
};
/** Each child row carries its attempt's finish, which stands in for the attempt it belongs to. */
type TelemetryRow = PlannedTelemetryRow & {
  status: string;
  countsBasis: string | null;
  recordedMsAgo: number;
};
type LlmUsageRow = Omit<PlannedLlmUsage, 'costMicroUsd'> & {
  recordedMsAgo: number;
  costUsd: string;
};
type QualityCheckRow = PlannedQualityCheck & { recordedMsAgo: number };

function msAgo(column: string) {
  return sql<number>`round(extract(epoch FROM now() - ${sql.ref(column)}) * 1000)::double precision`;
}

/** What the metrics views show of the history, as `metrics_reader` sees it, in the plan's terms.
 * `telemetryColumns` are the telemetry row's own, so the view's ids and derived columns are left
 * out. */
async function readHistory(
  transaction: Transaction<Database>,
  { organizationIds, userIds }: InsertedSyntheticHistory,
  telemetryColumns: string[],
) {
  // The organization itself has no view, so it is read before taking the role.
  const { rows: organizations } = await sql<OrganizationRow>`
    SELECT ${msAgo('created_at')} AS "createdMsAgo",
      (SELECT count(*)::int FROM organization_member m WHERE m.organization_id = o.id) AS members
    FROM organization o WHERE id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);

  await sql`SET LOCAL ROLE metrics_reader`.execute(transaction);
  const { rows: users } = await sql<UserRow>`
    SELECT ${msAgo('created_at')} AS "createdMsAgo", ${msAgo('email_confirmed_at')} AS "emailConfirmedMsAgo",
      ${msAgo('last_sign_in_at')} AS "lastSignInMsAgo", country
    FROM metrics.app_user WHERE id = ANY(${userIds}::uuid[])
  `.execute(transaction);
  const { rows: reports } = await sql<{ createdMsAgo: number }>`
    SELECT ${msAgo('created_at')} AS "createdMsAgo"
    FROM metrics.report WHERE organization_id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);
  const { rows: attempts } = await sql<AttemptRow>`
    SELECT attempt_number AS "attemptNumber", status, failure_reason AS "failureReason",
      ${msAgo('created_at')} AS "createdMsAgo", ${msAgo('claimed_at')} AS "claimedMsAgo",
      ${msAgo('finished_at')} AS "finishedMsAgo",
      ${msAgo('notification_email_sent_at')} AS "notifiedMsAgo",
      has_requester AS "hasRequester"
    FROM metrics.attempt WHERE organization_id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);
  const { rows: telemetry } = await sql<TelemetryRow>`
    SELECT status, counts_basis, ${msAgo('recorded_at')} AS "recordedMsAgo",
      ${sql.join(telemetryColumns.map((column) => sql.ref(column)))}
    FROM metrics.attempt_telemetry WHERE organization_id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);
  const { rows: llmUsage } = await sql<LlmUsageRow>`
    SELECT ${msAgo('recorded_at')} AS "recordedMsAgo", operation, requested_model, served_model,
      calls, requests, failed_requests, rate_limited_requests, truncated_calls, input_tokens,
      cached_input_tokens, output_tokens, cost_usd
    FROM metrics.attempt_llm_usage WHERE organization_id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);
  const { rows: qualityChecks } = await sql<QualityCheckRow>`
    SELECT ${msAgo('recorded_at')} AS "recordedMsAgo", quality_check, status, findings
    FROM metrics.attempt_quality_check WHERE organization_id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);
  await sql`RESET ROLE`.execute(transaction);

  return { organizations, users, reports, attempts, telemetry, llmUsage, qualityChecks };
}

/** The telemetry the plan gives each claimed attempt, as the three views show it. */
function plannedTelemetry(plan: SyntheticHistoryPlan) {
  const claimed = plan.organizations.flatMap(({ reports }) =>
    reports.flatMap(({ countsBasis, attempts }) =>
      attempts.flatMap((attempt: PlannedAttempt) =>
        attempt.status === 'canceled' ? [] : [{ ...attempt, countsBasis }],
      ),
    ),
  );
  return {
    telemetryColumns: Object.keys(claimed[0]?.telemetry.row ?? {}),
    telemetry: claimed.map(
      ({ status, countsBasis, finishedMsAgo, telemetry }): TelemetryRow => ({
        status,
        countsBasis,
        recordedMsAgo: finishedMsAgo,
        ...telemetry.row,
      }),
    ),
    llmUsage: claimed.flatMap(({ finishedMsAgo, telemetry }) =>
      telemetry.llmUsage.map(
        ({ costMicroUsd, ...usage }): LlmUsageRow => ({
          recordedMsAgo: finishedMsAgo,
          ...usage,
          costUsd: (costMicroUsd / 1e6).toFixed(6),
        }),
      ),
    ),
    qualityChecks: claimed.flatMap(({ finishedMsAgo, telemetry }) =>
      telemetry.qualityChecks.map(
        (check): QualityCheckRow => ({ recordedMsAgo: finishedMsAgo, ...check }),
      ),
    ),
  };
}

function sorted<T>(rows: T[]): T[] {
  return rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('insertSyntheticHistory', () => {
  test('writes what the plan says, and it commits', async () => {
    const plan = planSyntheticHistory(SYNTHETIC_HISTORY_SEED);
    const { telemetryColumns, ...expectedTelemetry } = plannedTelemetry(plan);

    const history = await withRollback(DATABASE, async (transaction) => {
      const inserted = await insertSyntheticHistory(transaction, plan);
      await checkDeferredConstraints(transaction);
      return await readHistory(transaction, inserted, telemetryColumns);
    });

    const users = [
      ...plan.organizations.flatMap(({ admin, members }) => [admin, ...members]),
      ...plan.unconfirmedUsers,
    ].map((user): UserRow => ({ ...user, lastSignInMsAgo: user.emailConfirmedMsAgo }));
    const reports = plan.organizations.flatMap((organization) => organization.reports);
    const attempts = reports.flatMap((report) =>
      report.attempts.map(
        (attempt, index): AttemptRow => ({
          attemptNumber: index + 1,
          status: attempt.status,
          failureReason: attempt.status === 'failed' ? attempt.failureReason : null,
          createdMsAgo: attempt.createdMsAgo,
          claimedMsAgo: attempt.status === 'canceled' ? null : attempt.claimedMsAgo,
          finishedMsAgo: attempt.finishedMsAgo,
          notifiedMsAgo: attempt.status === 'canceled' ? null : attempt.notifiedMsAgo,
          hasRequester: true,
        }),
      ),
    );
    expect(sorted(history.organizations)).toEqual(
      sorted(
        plan.organizations.map((organization) => ({
          createdMsAgo: organization.createdMsAgo,
          members: 1 + organization.members.length,
        })),
      ),
    );
    expect(sorted(history.users)).toEqual(sorted(users));
    expect(sorted(history.reports)).toEqual(
      sorted(reports.map(({ createdMsAgo }) => ({ createdMsAgo }))),
    );
    expect(sorted(history.attempts)).toEqual(sorted(attempts));
    expect(sorted(history.telemetry)).toEqual(sorted(expectedTelemetry.telemetry));
    expect(sorted(history.llmUsage)).toEqual(sorted(expectedTelemetry.llmUsage));
    expect(sorted(history.qualityChecks)).toEqual(sorted(expectedTelemetry.qualityChecks));
  });
});
