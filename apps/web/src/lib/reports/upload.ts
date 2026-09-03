/** The client-side call behind the new-report form. */

import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { createReportApiHref, organizationHref } from '$lib/hrefs';
import { parseUploadRejection, type UploadRejection } from './rejection.ts';

export type UploadOutcome =
  | { kind: 'created'; location: string }
  | { kind: 'rejected'; rejection: UploadRejection }
  | { kind: 'unknown' };

export async function uploadReport(
  organizationId: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  try {
    const response = await apiCall(createReportApiHref(organizationId), {
      method: 'POST',
      body: form,
      signal,
    });
    return {
      kind: 'created',
      location: response.headers.get('location') ?? organizationHref(organizationId),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      const rejection = parseUploadRejection(error);
      if (rejection) return { kind: 'rejected', rejection };
    }
    // Everything else — `ApiUnreachableError`, a 5xx, a 400/429 that isn't a rejection, and a
    // 401/403/404 (the page's `load` already guarded access, so reaching one here means the
    // session died mid-form) — is answered the same way: we don't know whether the upload was
    // received, so the safe advice is to go check the report list.
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
