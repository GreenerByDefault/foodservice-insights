import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError, apiCall } from './client.ts';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiCall', () => {
  test('resolves with the response on a 2xx', async () => {
    stubFetch(new Response(null, { status: 204 }));

    const response = await apiCall('/api/orgs/org-1/reports');

    expect(response.status).toBe(204);
  });

  test('a non-2xx JSON body becomes an ApiError carrying status, message, and the body', async () => {
    const body = { message: 'The file could not be read', summary: 'The file could not be read' };
    stubFetch(new Response(JSON.stringify(body), { status: 400 }));

    await expect(apiCall('/api/orgs/org-1/reports')).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: 'The file could not be read',
      body,
    });
  });

  test('a non-JSON body falls back to statusText', async () => {
    stubFetch(
      new Response('<html>gateway timeout</html>', { status: 504, statusText: 'Gateway Timeout' }),
    );

    await expect(apiCall('/api/orgs/org-1/reports')).rejects.toMatchObject({
      constructor: ApiError,
      status: 504,
      message: 'Gateway Timeout',
    });
  });

  test('a rejecting fetch becomes an ApiUnreachableError', async () => {
    const cause = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    await expect(apiCall('/api/orgs/org-1/reports')).rejects.toMatchObject({
      constructor: ApiUnreachableError,
      cause,
    });
  });

  test('a FormData body sets no Content-Type, leaving the browser to set its own boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCall('/api/orgs/org-1/reports', { method: 'POST', body: new FormData() });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options.headers['Content-Type']).toBeUndefined();
  });

  test('a JSON body does get a Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCall('/api/orgs/org-1/reports', { method: 'POST', body: '{}' });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options.headers['Content-Type']).toBe('application/json');
  });
});
