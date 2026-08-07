/** Calling this app's own endpoints, and the error shape they answer with.
 *
 * Every failure reaches the client as `App.Error` — `{ message, code? }` — because that is what
 * SvelteKit serialises when a handler throws `error()`. `apiCall` turns a non-2xx into an
 * `ApiError` carrying that shape, so a caller branches on `status` or `code` and never on a
 * parsed message.
 */

import type { RejectedUploadReason } from '@gbd/db';

/** Reasons a request failed, for a client that wants to say something specific.
 *
 * Upload rejections reuse `rejected_upload_reason`, so the code the user is shown and the code
 * the database recorded are the same word.
 */
export type ErrorCode = RejectedUploadReason | 'unauthenticated' | 'not_found' | 'internal';

/** How long to wait before giving up on a request.
 *
 * Generous because the slowest call is a 10MB upload on a poor connection. It is not the
 * server's timeout — that belongs to the server.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Call an endpoint, throwing `ApiError` on anything that is not a 2xx. */
export async function apiCall(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const isFormData = options.body instanceof FormData;

  const response = await fetch(endpoint, {
    ...options,
    headers: {
      // SvelteKit content-negotiates its error responses, and the default `*/*` leaves the
      // choice to it. Ask for the shape this function knows how to read.
      accept: 'application/json',
      // Deliberately absent for FormData: the browser has to write the multipart boundary into
      // this header itself, and setting it by hand produces a body the server cannot parse.
      ...(isFormData ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (response.ok) return response;
  throw await toApiError(response);
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      const code = 'code' in body ? (body.code as ErrorCode) : undefined;
      return new ApiError(response.status, body.message, code);
    }
  } catch {
    // Not JSON. Some failures never reach our handlers — a proxy timeout, or adapter-node
    // rejecting an oversized body — so this path is normal rather than exceptional.
  }
  return new ApiError(
    response.status,
    response.statusText || `Request failed (${response.status})`,
  );
}
