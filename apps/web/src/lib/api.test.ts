import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, apiCall } from './api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Capture what `apiCall` sends, and reply with `response`. */
function stubFetch(response: Response): { requestInit: () => RequestInit } {
  let captured: RequestInit = {};
  vi.stubGlobal('fetch', (_endpoint: string, init: RequestInit) => {
    captured = init;
    return Promise.resolve(response);
  });
  return { requestInit: () => captured };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('apiCall', () => {
  test('returns the response when it is a 2xx', async () => {
    const ok = new Response(null, { status: 204 });
    stubFetch(ok);

    expect(await apiCall('/api/reports', { method: 'POST' })).toBe(ok);
  });

  test('turns an App.Error body into an ApiError carrying its code', async () => {
    stubFetch(Response.json({ message: 'That file is empty', code: 'empty' }, { status: 400 }));

    await expect(apiCall('/api/reports', { method: 'POST' })).rejects.toMatchObject({
      status: 400,
      message: 'That file is empty',
      code: 'empty',
    });
  });

  test('falls back to the status text when the body is not JSON', async () => {
    // What adapter-node answers with when the body exceeds BODY_SIZE_LIMIT: plain text, from
    // outside any of our handlers.
    stubFetch(new Response('Payload Too Large', { status: 413, statusText: 'Payload Too Large' }));

    const failure = await apiCall('/api/reports', { method: 'POST' }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 413, message: 'Payload Too Large', code: undefined });
  });

  test('leaves Content-Type to the browser for FormData, so the boundary is written', async () => {
    const stub = stubFetch(new Response(null, { status: 204 }));

    await apiCall('/api/reports', { method: 'POST', body: new FormData() });

    expect(headersOf(stub.requestInit())).not.toHaveProperty('content-type');
    expect(headersOf(stub.requestInit())).toMatchObject({ accept: 'application/json' });
  });

  test('sends JSON content type for every other body', async () => {
    const stub = stubFetch(new Response(null, { status: 204 }));

    await apiCall('/api/reports', { method: 'POST', body: '{}' });

    expect(headersOf(stub.requestInit())).toMatchObject({ 'content-type': 'application/json' });
  });
});
