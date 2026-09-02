import type { AnalysisAttemptStatus } from '@gbd/db';

/** The status a screen shows, which is not always the raw column.
 *
 * The web server never writes `analysis_attempt.status` — canceling only writes
 * `cancel_requested_at`, and a worker converges it to `canceled` on its next lease renewal or the
 * queue's cancel sweep (see `ARCHITECTURE.md` § Canceling). So a request that was cancelled but
 * finished first still records `succeeded` or `failed`, and that verdict stands: a reader has to
 * trust `status` over the request. Only a still-pending or still-processing attempt with a
 * request on it reads as `canceled` before the worker gets there.
 */
export function screenStatus(attempt: {
  status: AnalysisAttemptStatus;
  cancelRequestedAt: Date | null;
}): AnalysisAttemptStatus {
  if (
    attempt.cancelRequestedAt !== null &&
    (attempt.status === 'pending' || attempt.status === 'processing')
  ) {
    return 'canceled';
  }
  return attempt.status;
}

/** Whether an attempt is still running. */
export function isWaiting<T extends { status: AnalysisAttemptStatus }>(
  attempt: T,
): attempt is Extract<T, { status: 'pending' | 'processing' }> {
  return attempt.status === 'pending' || attempt.status === 'processing';
}
