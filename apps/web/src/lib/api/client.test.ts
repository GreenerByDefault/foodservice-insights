import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError, apiCall } from './client.ts';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiCall', () => {
  test('resolves with the response on a 2xx, unmodified', async () => {
    stubFetch(
      new Response('{"id":"report-1"}', {
        status: 201,
        headers: { Location: '/api/orgs/org-1/reports/report-1' },
      }),
    );

    const response = await apiCall('/api/orgs/org-1/reports');

    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toBe('/api/orgs/org-1/reports/report-1');
    await expect(response.json()).resolves.toEqual({ id: 'report-1' });
  });

  test('forwards the url and method to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCall('/api/orgs/org-1/reports', { method: 'DELETE' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orgs/org-1/reports',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('a non-2xx JSON body becomes an ApiError carrying status, message, and jsonBody', async () => {
    const body = { message: 'The file could not be read', summary: 'The file could not be read' };
    stubFetch(new Response(JSON.stringify(body), { status: 400 }));

    await expect(apiCall('/api/orgs/org-1/reports')).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: 'The file could not be read',
      jsonBody: body,
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

  test('a JSON body without a message field falls back to statusText', async () => {
    const body = { summary: 'The file could not be read' };
    stubFetch(new Response(JSON.stringify(body), { status: 400, statusText: 'Bad Request' }));

    await expect(apiCall('/api/orgs/org-1/reports')).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: 'Bad Request',
      jsonBody: body,
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

  test('a caller-supplied header overrides the default Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiCall('/api/orgs/org-1/reports', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options.headers['Content-Type']).toBe('application/merge-patch+json');
  });
});
