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

/** This timeout covers most of our routes: small Postgres reads/writes with room for a cold
 * connection or a slow query. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Makes an API request and throws on a non-2xx, unreachable, or timed-out response.
 *
 * Skips `Content-Type` for a `FormData` body so the browser can set its own multipart boundary.
 * Aborts after `timeoutMs` (default `DEFAULT_TIMEOUT_MS`), combined with any caller-supplied
 * `signal`.
 */
export async function apiCall(
  url: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = options ?? {};
  const isFormData = rest.body instanceof FormData;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: {
        ...(!isFormData && { 'Content-Type': 'application/json' }),
        ...rest.headers,
      },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
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
