import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import type { Database } from '../../schema.ts';
import { checkDeferredConstraints, withRollback } from '../transactions.ts';
import { type InsertedSyntheticHistory, insertSyntheticHistory } from './insert.ts';
import { planSyntheticHistory, SYNTHETIC_HISTORY_SEED } from './plan.ts';

type UserRow = { createdMsAgo: number; emailConfirmedMsAgo: number | null };
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

function msAgo(column: string) {
  return sql<number>`round(extract(epoch FROM now() - ${sql.ref(column)}) * 1000)::double precision`;
}

/** What the metrics views show of the history, as `metrics_reader` sees it, in the plan's terms. */
async function readHistory(
  transaction: Transaction<Database>,
  { organizationIds, userIds }: InsertedSyntheticHistory,
) {
  // The organization itself has no view, so it is read before taking the role.
  const { rows: organizations } = await sql<OrganizationRow>`
    SELECT ${msAgo('created_at')} AS "createdMsAgo",
      (SELECT count(*)::int FROM organization_member m WHERE m.organization_id = o.id) AS members
    FROM organization o WHERE id = ANY(${organizationIds}::uuid[])
  `.execute(transaction);

  await sql`SET LOCAL ROLE metrics_reader`.execute(transaction);
  const { rows: users } = await sql<UserRow>`
    SELECT ${msAgo('created_at')} AS "createdMsAgo", ${msAgo('email_confirmed_at')} AS "emailConfirmedMsAgo"
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
  await sql`RESET ROLE`.execute(transaction);

  return { organizations, users, reports, attempts };
}

function sorted<T>(rows: T[]): T[] {
  return rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('insertSyntheticHistory', () => {
  test('writes what the plan says, and it commits', async () => {
    const plan = planSyntheticHistory(SYNTHETIC_HISTORY_SEED);

    const history = await withRollback(DATABASE, async (transaction) => {
      const inserted = await insertSyntheticHistory(transaction, plan);
      await checkDeferredConstraints(transaction);
      return await readHistory(transaction, inserted);
    });

    const users = [
      ...plan.organizations.flatMap(({ admin, members }) => [admin, ...members]),
      ...plan.unconfirmedUsers,
    ];
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
  });
});
