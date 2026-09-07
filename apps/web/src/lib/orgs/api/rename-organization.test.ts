import { afterEach, describe, expect, test, vi } from 'vitest';
import { renameOrganization } from './rename-organization.ts';

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renameOrganization', () => {
  test('PATCHes the organization with the new name', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(renameOrganization('org-1', 'Riverside Foods')).resolves.toEqual({
      kind: 'renamed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orgs/org-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Riverside Foods' });
  });

  test('a write failure is classified by classifyNameWriteFailure', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Taken', code: 'name-taken' }), { status: 409 }),
    );

    await expect(renameOrganization('org-1', 'Riverside Foods')).resolves.toEqual({
      kind: 'name-taken',
    });
  });
});
