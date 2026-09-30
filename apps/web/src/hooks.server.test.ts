import type { UserId } from '@gbd/db';
import { aDatabaseError, anUnreachableDatabaseError } from '@gbd/db/testing';
import { type HandleServerError, isHttpError, type RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as mode from '$lib/auth/mode';
import * as authorization from '$lib/server/auth/authorization';
import * as identify from '$lib/server/auth/identify';
import { anAuthContext } from '$lib/server/testing/fixtures';
import { SERVER_LOGS } from '$lib/server/testing/logs';
import { handle, handleError } from './hooks.server.ts';

// This file tests only the hook's wiring, so identification and authorization are stubbed.
// See $lib/server/auth/authorization.test.ts for their tests.
vi.mock('$lib/server/auth/identify', () => ({ identifyUser: vi.fn() }));
vi.mock('$lib/server/auth/authorization', () => ({ loadAuthorization: vi.fn() }));
vi.mock('$lib/auth/mode', () => ({ authMode: vi.fn() }));

const A_USER_ID = crypto.randomUUID() as UserId;

beforeEach(() => {
  vi.mocked(identify.identifyUser).mockReset().mockResolvedValue(A_USER_ID);
  vi.mocked(authorization.loadAuthorization).mockReset().mockResolvedValue(anAuthContext());
  vi.mocked(mode.authMode).mockReset().mockReturnValue('supabase');
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
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(anUnreachableDatabaseError());

    try {
      await handle({ event: anEvent(), resolve: respond });
      expect.unreachable('handle should have thrown');
    } catch (thrown) {
      if (!isHttpError(thrown)) throw thrown;
      expect(thrown.status).toBe(503);
      expect(thrown.body.code).toBe('service_unavailable');
    }
    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Could not reach the database to load authorization',
        userId: A_USER_ID,
        err: expect.objectContaining({ code: 'ECONNREFUSED' }),
      },
    ]);
  });

  // Authorization is a plain read, so Postgres refusing it is our bug rather than something the
  // user can wait out.
  test('500s a statement Postgres refused, rather than reporting an outage', async () => {
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(
      aDatabaseError('column "emial" does not exist', '42703'),
    );

    try {
      await handle({ event: anEvent(), resolve: respond });
      expect.unreachable('handle should have thrown');
    } catch (thrown) {
      if (!isHttpError(thrown)) throw thrown;
      expect(thrown.status).toBe(500);
    }
  });

  // `loadAuthorization` can also fail for reasons that have nothing to do with reachability,
  // such as a data invariant it checks itself.
  test('does not 503 an authorization failure that is not a database error', async () => {
    const cause = new Error('the user has no email');
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(cause);

    await expect(handle({ event: anEvent(), resolve: respond })).rejects.toBe(cause);
  });

  describe('an identified user with no database row', () => {
    beforeEach(() => {
      vi.mocked(authorization.loadAuthorization).mockResolvedValue(null);
    });

    test('fails loudly in placeholder mode, pointing at the seed', async () => {
      vi.mocked(mode.authMode).mockReturnValue('placeholder');

      await expect(handle({ event: anEvent(), resolve: respond })).rejects.toThrow(
        /pnpm seed:identity/,
      );
    });

    test('fails loudly in supabase mode, pointing at the database', async () => {
      await expect(handle({ event: anEvent(), resolve: respond })).rejects.toThrow(/DATABASE_URL/);
    });
  });
});

describe('handleError', () => {
  test('logs an unexpected failure with enough to find it again, and tells the client none of it', async () => {
    const cause = new Error('password authentication failed for user "app"');

    const body = await bodyFrom({
      error: cause,
      event: anEvent('/reports'),
      status: 500,
      message: 'Internal Error',
    });

    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Unhandled server error',
        status: 500,
        method: 'GET',
        path: '/reports',
        routeId: null,
        err: expect.objectContaining({ type: 'Error', message: cause.message }),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('password authentication');
  });

  test('stays quiet about a 404, which is not a failure of ours', async () => {
    const body = await bodyFrom({
      error: new Error('Not found'),
      event: anEvent('/no-such-page'),
      status: 404,
      message: 'Not Found',
    });

    expect(body).toEqual({ message: 'Not Found', code: 'not_found' });
    expect(SERVER_LOGS.records).toEqual([]);
  });
});
