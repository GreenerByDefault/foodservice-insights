import { afterEach, describe, expect, test, vi } from 'vitest';
import { lastFetchCall, stubFetch } from '$lib/testing/fetch';
import { createOrganization } from './create-organization.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOrganization', () => {
  test('POSTs the name and resolves with the location header', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ organizationId: 'org-1' }), {
        status: 201,
        headers: { location: '/orgs/org-1' },
      }),
    );

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({
      kind: 'created',
      location: '/orgs/org-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Acme Foodservice' });
  });

  test('a 201 with no location header falls back to /orgs', async () => {
    stubFetch(new Response(JSON.stringify({ organizationId: 'org-1' }), { status: 201 }));

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({
      kind: 'created',
      location: '/orgs',
    });
  });

  test('a write failure is classified by classifyNameWriteFailure', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Taken', code: 'name-taken' }), { status: 409 }),
    );

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({ kind: 'name-taken' });
  });

  test.for([
    ['slug-taken', 409],
    ['slug-reserved', 422],
    ['slug-underivable', 422],
  ] as const)('a %s failure is classified from the body code', async ([code, status]) => {
    stubFetch(new Response(JSON.stringify({ message: 'Nope', code }), { status }));

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({ kind: code });
  });
});
