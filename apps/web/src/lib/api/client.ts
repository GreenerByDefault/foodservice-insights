/** The one place components call `fetch`, so no component has to decide how a failure is
 * classified.
 *
 * This layer knows only HTTP. A feature's own client is what knows which statuses its endpoint
 * means and what its bodies are.
 */

/** Any value `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The server answered, but not with a 2xx. */
export class ApiError extends Error {
  constructor(
    public status: number,
    /** A log or last-resort string, like the HTTP code description. */
    message: string,
    /** The parsed body, for the feature client that knows its shape. `undefined` if the body
     * wasn't valid JSON. */
    public jsonBody: JsonValue | undefined,
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
  let jsonBody: JsonValue | undefined;
  try {
    jsonBody = await response.json();
    if (
      jsonBody &&
      typeof jsonBody === 'object' &&
      !Array.isArray(jsonBody) &&
      typeof jsonBody.message === 'string'
    ) {
      message = jsonBody.message;
    }
  } catch {
    jsonBody = undefined;
  }
  throw new ApiError(response.status, message, jsonBody);
}
