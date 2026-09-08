import { ApiError, apiCall } from '$lib/api/fetch';
import { retryReportApiHref } from '$lib/hrefs';

/** What happened when the user asked to retry.
 *
 * `already-retried` is the endpoint's 409: another attempt already exists, or the report is
 * out of retries. Either way there is nothing this request can do — the page's own refresh shows
 * the attempt that actually exists, so both outcomes here are followed by the same refresh.
 */
export type RetryOutcome = 'retried' | 'already-retried';

export async function retryReport(organizationId: string, reportId: string): Promise<RetryOutcome> {
  try {
    await apiCall(retryReportApiHref(organizationId, reportId), { method: 'POST' });
    return 'retried';
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return 'already-retried';
    throw cause;
  }
}
