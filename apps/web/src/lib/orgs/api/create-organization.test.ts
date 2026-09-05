import { afterEach, describe, expect, test, vi } from 'vitest';
import { createOrganization } from './create-organization.ts';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOrganization', () => {
  test('a 201 resolves with the location header', async () => {
    stubFetch(
      new Response(JSON.stringify({ organizationId: 'org-1' }), {
        status: 201,
        headers: { location: '/orgs/org-1' },
      }),
    );

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({
      kind: 'created',
      location: '/orgs/org-1',
    });
  });

  test('a 409 is a name collision', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Taken', code: 'name-taken' }), { status: 409 }),
    );

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({ kind: 'name-taken' });
  });

  test('a 400 is unknown, not a name collision', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Invalid' }), { status: 400 }));

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(createOrganization('Acme Foodservice')).resolves.toEqual({ kind: 'unknown' });
  });
});
