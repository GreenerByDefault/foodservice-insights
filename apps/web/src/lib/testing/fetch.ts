import { expect, vi } from 'vitest';

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

/** Asserts `fetchMock` was called exactly once, with the given url, method, and (if given) a JSON
 * body — the `lastFetchCall` triplet every write test repeats. */
export function expectFetched(
  fetchMock: ReturnType<typeof vi.fn>,
  expected: { url: string; method: string; body?: unknown },
) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = lastFetchCall(fetchMock);
  expect(url).toBe(expected.url);
  expect(options.method).toBe(expected.method);
  if ('body' in expected) expect(JSON.parse(options.body as string)).toEqual(expected.body);
}
