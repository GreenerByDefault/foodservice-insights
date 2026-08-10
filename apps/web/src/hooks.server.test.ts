import type { UserId } from '@gbd/db';
import { type HandleServerError, isHttpError, type RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as authorization from '$lib/server/auth/authorization';
import * as identify from '$lib/server/auth/identify';
import { closeDatabase } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { handle, handleError } from './hooks.server.ts';

// This file tests only the hook's wiring, so identification and authorization are stubbed.
// See $lib/server/auth/authorization.test.ts for their tests.
vi.mock('$lib/server/auth/identify', () => ({ identifyUser: vi.fn() }));
vi.mock('$lib/server/auth/authorization', () => ({ loadAuthorization: vi.fn() }));

const A_USER_ID = crypto.randomUUID() as UserId;

beforeEach(() => {
  vi.mocked(identify.identifyUser).mockReset().mockResolvedValue(A_USER_ID);
  vi.mocked(authorization.loadAuthorization).mockReset().mockResolvedValue(anAuthContext());
});

afterAll(async () => {
  await closeDatabase();
});

/** The parts of a request the hooks actually read. */
function anEvent(pathname = '/'): RequestEvent {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`),
    route: { id: null },
    locals: {},
  } as RequestEvent;
}

/** `handleError` may return nothing, and may be async. Ours is neither. */
async function bodyFrom(input: Parameters<HandleServerError>[0]): Promise<App.Error> {
  const body = await handleError(input);
  if (!body) throw new Error('Expected handleError to return a body.');
  return body;
}

const respond = async () => new Response('ok');

describe('handle', () => {
  test('sets baseline security headers on the response', async () => {
    const response = await handle({ event: anEvent(), resolve: respond });

    expect(Object.fromEntries(response.headers)).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
  });

  test("puts the identified user's authorization on locals", async () => {
    const auth = anAuthContext({ user: { email: 'cook@example.test' } });
    vi.mocked(authorization.loadAuthorization).mockResolvedValue(auth);
    const event = anEvent();

    await handle({ event, resolve: respond });

    expect(event.locals.auth).toBe(auth);
    expect(identify.identifyUser).toHaveBeenCalledWith(event);
  });

  test('leaves an unidentified request signed out', async () => {
    vi.mocked(identify.identifyUser).mockResolvedValue(null);
    const event = anEvent();

    await handle({ event, resolve: respond });

    expect(event.locals.auth).toBeNull();
    expect(authorization.loadAuthorization).not.toHaveBeenCalled();
  });

  test('leaves the liveness probe alone, so it can report on the database', async () => {
    const event = anEvent('/health');

    await handle({ event, resolve: respond });

    expect(event.locals.auth).toBeNull();
    expect(authorization.loadAuthorization).not.toHaveBeenCalled();
  });

  test('503s an unreachable database', async () => {
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(new Error('connection refused'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handle({ event: anEvent(), resolve: respond });
      expect.unreachable('handle should have thrown');
    } catch (thrown) {
      if (!isHttpError(thrown)) throw thrown;
      expect(thrown.status).toBe(503);
      expect(thrown.body.code).toBe('service_unavailable');
    }
    logged.mockRestore();
  });

  // This test is temporary and should be deleted when adding proper auth with JWTs.
  test('fails loudly when the identified user has no database row, rather than 401ing silently', async () => {
    vi.mocked(authorization.loadAuthorization).mockResolvedValue(null);

    await expect(handle({ event: anEvent(), resolve: respond })).rejects.toThrow(/pnpm seed/);
  });
});

describe('handleError', () => {
  test('logs an unexpected failure with enough to find it again, and tells the client none of it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new Error('password authentication failed for user "app"');

    const body = await bodyFrom({
      error: cause,
      event: anEvent('/reports'),
      status: 500,
      message: 'Internal Error',
    });

    expect(logged).toHaveBeenCalledWith(
      'Unhandled server error',
      expect.objectContaining({ status: 500, path: '/reports', error: cause }),
    );
    expect(JSON.stringify(body)).not.toContain('password authentication');
    logged.mockRestore();
  });

  test('stays quiet about a 404, which is not a failure of ours', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const body = await bodyFrom({
      error: new Error('Not found'),
      event: anEvent('/no-such-page'),
      status: 404,
      message: 'Not Found',
    });

    expect(body).toEqual({ message: 'Not Found', code: 'not_found' });
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
