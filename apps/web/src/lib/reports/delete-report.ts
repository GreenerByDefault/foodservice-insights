/** The client-side call behind the delete button on a settled report. */

import { apiCall } from '$lib/api/fetch';

export async function deleteReport(deleteHref: string): Promise<void> {
  await apiCall(deleteHref, { method: 'DELETE' });
}
