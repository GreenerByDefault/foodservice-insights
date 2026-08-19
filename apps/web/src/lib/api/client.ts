/** The one place components call `fetch`, so no component has to decide how a failure is
 * classified.
 *
 * This layer knows only HTTP. A feature's own client is what knows which statuses its endpoint
 * means and what its bodies are — see `$lib/reports/upload.ts`.
 */

/** The server answered, but not with a 2xx. `message` is for a log or a last-resort string;
 * `body` is the parsed payload, for the feature client that knows its shape.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
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
  let body: unknown;
  try {
    body = await response.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // Not a JSON body — fall back to statusText already set above.
  }
  throw new ApiError(response.status, message, body);
}
