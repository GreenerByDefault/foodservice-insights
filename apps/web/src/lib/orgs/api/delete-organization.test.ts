import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { deleteOrganization } from './delete-organization.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deleteOrganization', () => {
  test('a 204 resolves', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(deleteOrganization('org-1')).resolves.toBeUndefined();
  });

  test('a non-2xx status rethrows', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(deleteOrganization('org-1')).rejects.toMatchObject({
      constructor: ApiError,
      status: 404,
      message: 'Not found',
    });
  });

  test('an unreachable server rethrows', async () => {
    stubUnreachableFetch();

    await expect(deleteOrganization('org-1')).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
