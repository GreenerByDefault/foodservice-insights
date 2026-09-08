import { ApiError, apiCall } from '$lib/api/fetch';
import { cancelReportApiHref } from '$lib/hrefs';

/** What happened when the user asked to cancel.
 *
 * `already-settled` is the endpoint's 409: the attempt finished before the request landed. That
 * is not a failure to report — the load's own re-run shows whatever it actually finished as, so
 * both outcomes here are followed by the same refresh.
 */
export type CancelOutcome = 'canceled' | 'already-settled';

export async function cancelReport(
  organizationSlug: string,
  reportId: string,
): Promise<CancelOutcome> {
  try {
    await apiCall(cancelReportApiHref(organizationSlug, reportId), { method: 'POST' });
    return 'canceled';
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return 'already-settled';
    throw cause;
  }
}
