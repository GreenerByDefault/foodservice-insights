import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { handle } from './hooks.server.ts';

describe('handle', () => {
  it('sets baseline security headers on the response', async () => {
    const response = await handle({
      event: {} as RequestEvent,
      resolve: async () => new Response('ok')
    });

    expect(Object.fromEntries(response.headers)).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin'
    });
  });
});
