/** Move an analysis attempt's `created_at`/`claimed_at`/`lease_renewed_at` into the past.
 *
 * `now()` is a rolled-back test's transaction start time, so every statement inside one shares a
 * single value and a lease renewal, or a lease's age, could never be seen to move. Backdating the
 * columns a test needs to overtake is what gives them somewhere to move from.
 */

import type { AnalysisAttemptId, Database } from '@gbd/db';
import { sql, type Transaction } from 'kysely';

/** How far in the past (in milliseconds) each column should land. Unset columns default to the
 * next one along, so passing only `renewedAgo` backdates all three together — the shape
 * `queue.test.ts`'s original `backdate` used.
 *
 * The schema requires `created_at <= claimed_at <= lease_renewed_at`, so callers combining more
 * than one offset must keep `createdAgo >= claimedAgo >= renewedAgo`.
 */
export type TimelineOffsetsMs = {
  createdAgo?: number;
  claimedAgo?: number;
  renewedAgo?: number;
};

export async function backdateAttemptTimeline(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
  offsets: TimelineOffsetsMs = {},
): Promise<void> {
  const renewedAgo = offsets.renewedAgo ?? offsets.claimedAgo ?? offsets.createdAgo ?? 5 * 60_000;
  const claimedAgo = offsets.claimedAgo ?? offsets.createdAgo ?? renewedAgo;
  const createdAgo = offsets.createdAgo ?? claimedAgo;

  await transaction
    .updateTable('analysisAttempt')
    .set({
      createdAt: msAgo(createdAgo),
      claimedAt: msAgo(claimedAgo),
      leaseRenewedAt: msAgo(renewedAgo),
    })
    .where('id', '=', attemptId)
    .execute();
}

function msAgo(ms: number) {
  return sql<Date>`now() - make_interval(secs => ${ms / 1000})`;
}
