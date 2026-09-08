import { vi } from 'vitest';

/** Stubs `globalThis.fetch` to resolve with `response`, and returns the mock so a test can assert
 * on how it was called. Call `vi.unstubAllGlobals()` in an `afterEach` to undo it. */
export function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stubs `globalThis.fetch` to reject the way a browser does when the network is unreachable. */
export function stubUnreachableFetch() {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stubs `globalThis.fetch` with a request that never settles until the test calls `resolve` —
 * for asserting on in-flight state (a disabled button, a spinner) before the response arrives. */
export function stubPendingFetch() {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)));
  vi.stubGlobal('fetch', fetchMock);
  return { resolve };
}

/** A JSON `Response`, defaulting to 200. */
export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The `[url, init]` of a fetch mock's most recent call. */
export function lastFetchCall(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}
