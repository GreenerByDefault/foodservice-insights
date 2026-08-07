import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '$lib/server/db';
import { loadSession } from '$lib/server/session';
import { handle } from './hooks.server.ts';

// Kept real, so the ordinary path exercises the actual query; individual tests override it.
vi.mock('$lib/server/session', { spy: true });

afterAll(async () => {
  await closeDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request event with the empty `locals` SvelteKit hands the first hook. */
function anEvent(): RequestEvent {
  return { locals: {}, url: new URL('http://localhost/') } as RequestEvent;
}

describe('handle', () => {
  it('sets baseline security headers on the response', async () => {
    const response = await handle({ event: anEvent(), resolve: async () => new Response('ok') });

    expect(Object.fromEntries(response.headers)).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
  });

  it('puts the session on locals for the routes to read', async () => {
    const event = anEvent();

    await handle({ event, resolve: async () => new Response('ok') });

    // Deliberately not asserting *which* session: unit tests share a database with the e2e
    // suite, which seeds the placeholder identity, so whether one exists is not stable here.
    expect(event.locals).toHaveProperty('session');
  });

  it('serves the request with no session when the database cannot be reached', async () => {
    // Otherwise `/health` would answer 500 instead of reporting a degraded database — and
    // Playwright waits on `/health` before it runs anything.
    vi.mocked(loadSession).mockRejectedValueOnce(new Error('database is down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = anEvent();

    const response = await handle({ event, resolve: async () => new Response('ok') });

    expect(response.status).toBe(200);
    expect(event.locals.session).toBeNull();
  });
});
