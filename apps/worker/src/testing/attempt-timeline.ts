/** Move an analysis attempt's timestamps into the past.
 *
 * `now()` is a rolled-back test's transaction start time, so every statement inside one shares a
 * single value and a lease renewal, or a lease's age, could never be seen to move. Backdating the
 * columns a test needs to overtake is what gives them somewhere to move from.
 */

import type { AnalysisAttemptId, Database } from '@gbd/db';
import type { Transaction } from 'kysely';
import { msAgo } from '../sql.ts';

/** How far in the past (in milliseconds) each column should land. Unset columns default to the
 * next one along, so passing only `renewedAgo` backdates `created_at`/`claimed_at`/
 * `lease_renewed_at` together — the shape `queue.test.ts`'s original `backdate` used.
 *
 * Combining offsets must keep `createdAgo >= claimedAgo >= renewedAgo >= finishedAgo >=
 * notificationClaimedAgo`, matching `created_at <= claimed_at <= lease_renewed_at <= finished_at`
 * — only that middle inequality is schema-enforced, by
 * `analysis_attempt_finished_at_after_lease_renewed`.
 */
export type TimelineOffsetsMs = {
  createdAgo?: number;
  claimedAgo?: number;
  renewedAgo?: number;
  finishedAgo?: number;
  notificationClaimedAgo?: number;
};

export async function backdateAttemptTimeline(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
  offsets: TimelineOffsetsMs = {},
): Promise<void> {
  const renewedAgo = offsets.renewedAgo ?? offsets.claimedAgo ?? offsets.createdAgo ?? 5 * 60_000;
  const claimedAgo = offsets.claimedAgo ?? offsets.createdAgo ?? renewedAgo;
  const createdAgo = offsets.createdAgo ?? claimedAgo;
  const finishedAgo = offsets.finishedAgo ?? offsets.notificationClaimedAgo ?? renewedAgo;
  const notificationClaimedAgo = offsets.notificationClaimedAgo ?? finishedAgo;

  await transaction
    .updateTable('analysisAttempt')
    .set({
      createdAt: msAgo(createdAgo),
      claimedAt: msAgo(claimedAgo),
      leaseRenewedAt: msAgo(renewedAgo),
      // Unlike the three above, only set when named: every reaper test backdates a `processing`
      // attempt, whose finished_at must stay NULL.
      ...(offsets.finishedAgo !== undefined || offsets.notificationClaimedAgo !== undefined
        ? { finishedAt: msAgo(finishedAgo) }
        : {}),
      ...(offsets.notificationClaimedAgo !== undefined
        ? { notificationClaimedAt: msAgo(notificationClaimedAgo) }
        : {}),
    })
    .where('id', '=', attemptId)
    .execute();
}
