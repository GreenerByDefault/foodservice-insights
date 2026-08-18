/** The one place components call `fetch`, so no component has to decide how a failure is
 * classified.
 *
 * `ApiError` and `ApiUnreachableError` are deliberately separate: the server answering with a
 * bad status is a known outcome a form can render, while `fetch` itself rejecting means the
 * request's fate is unknown — REQUIREMENTS.md § Errors requires the UI to say that rather than
 * imply a retry is safe.
 */

/** The server answered, but not with a 2xx. Carries whatever the body offered, which covers both
 * `App.Error` (`message`, `code`) and `RejectedUploadResponse` (`message`, `code`, `problems`).
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public problems?: readonly string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `fetch` itself rejected or was aborted — no response ever arrived, so the request may or may
 * not have been received.
 */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the server', { cause });
    this.name = 'ApiUnreachableError';
  }
}

/** Makes an API request and throws on a non-2xx or unreachable response.
 *
 * Skips `Content-Type` for a `FormData` body so the browser can set its own multipart boundary.
 * Callers uploading a file should pass their own `signal` rather than rely on a default timeout,
 * since an upload can legitimately take longer than a small request.
 */
export async function apiCall(url: string, options?: RequestInit): Promise<Response> {
  const isFormData = options?.body instanceof FormData;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(!isFormData && { 'Content-Type': 'application/json' }),
        ...options?.headers,
      },
    });
  } catch (cause) {
    throw new ApiUnreachableError(cause);
  }

  if (response.ok) return response;

  let message = response.statusText;
  let code: string | undefined;
  let problems: readonly string[] | undefined;
  try {
    const body = await response.json();
    message = body.message ?? message;
    code = body.code;
    problems = body.problems;
  } catch {
    // Not a JSON body — fall back to statusText already set above.
  }
  throw new ApiError(response.status, message, code, problems);
}
