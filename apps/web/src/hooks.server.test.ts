import type { UserId } from '@gbd/db';
import { aDatabaseError, anUnreachableDatabaseError } from '@gbd/db/testing';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as mode from '#lib/auth/mode.js';
import { UNEXPECTED_ERROR_MESSAGE } from '#lib/errors/messages.js';
import * as authorization from '#lib/server/auth/authorization.js';
import * as identify from '#lib/server/auth/identify.js';
import { anAuthContext } from '#lib/server/testing/fixtures.js';
import { SERVER_LOGS } from '#lib/server/testing/logs.js';
import { getRequestEvent } from '$app/server';
import type { RouteId } from '$app/types';
import { handle, handleError } from './hooks.server.ts';

// This file tests only the hook's wiring, so identification and authorization are stubbed.
// See #lib/server/auth/authorization.test.ts for their tests.
vi.mock('#lib/server/auth/identify.js', () => ({ identifyUser: vi.fn() }));
vi.mock('#lib/server/auth/authorization.js', () => ({ loadAuthorization: vi.fn() }));
vi.mock('#lib/auth/mode.js', () => ({ authMode: vi.fn() }));

const A_USER_ID = crypto.randomUUID() as UserId;

beforeEach(() => {
  vi.mocked(identify.identifyUser).mockReset().mockResolvedValue(A_USER_ID);
  vi.mocked(authorization.loadAuthorization).mockReset().mockResolvedValue(anAuthContext());
  vi.mocked(mode.authMode).mockReset().mockReturnValue('supabase');
});

/** The parts of a request the hooks actually read. */
function anEvent(pathname = '/', routeId: RouteId | null = null): RequestEvent {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`),
    route: { id: routeId },
    locals: {},
  } as RequestEvent;
}

const respond = async () => new Response('ok');

/** What `handle` binds to every line of one request. */
function requestIdOf(response: Response): string {
  const requestId = response.headers.get('x-request-id');
  if (requestId === null) throw new Error('The response has no x-request-id');
  return requestId;
}

describe('handle', () => {
  test('sets baseline security headers on the response', async () => {
    const response = await handle({ event: anEvent(), resolve: respond });

    expect(Object.fromEntries(response.headers)).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
  });

  test('logs one line per request, under the id the response carries', async () => {
    const auth = anAuthContext();
    vi.mocked(authorization.loadAuthorization).mockResolvedValue(auth);

    const response = await handle({
      event: anEvent('/orgs/acme/members', '/(app)/orgs/[organizationSlug=slug]/members'),
      resolve: async () => new Response('ok', { status: 201 }),
    });

    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'info',
        msg: 'Request',
        requestId: requestIdOf(response),
        method: 'GET',
        routeId: '/(app)/orgs/[organizationSlug=slug]/members',
        path: '/orgs/acme/members',
        status: 201,
        durationMs: expect.any(Number),
        userId: auth.user.id,
      },
    ]);
  });

  test('gives each request its own id', async () => {
    const first = await handle({ event: anEvent(), resolve: respond });
    const second = await handle({ event: anEvent(), resolve: respond });

    expect(requestIdOf(first)).not.toBe(requestIdOf(second));
  });

  test('logs a poll at debug, so the default level shows only what a person did', async () => {
    await handle({
      event: anEvent('/orgs/acme/poll', '/(app)/orgs/[organizationSlug=slug]/poll'),
      resolve: respond,
    });

    expect(SERVER_LOGS.records).toEqual([expect.objectContaining({ level: 'debug' })]);
  });

  test("leaves a file link's path out of the log, since the link alone downloads the file", async () => {
    const fileId = crypto.randomUUID();

    await handle({
      event: anEvent(`/file/result/${fileId}`, '/file/result/[id=uuid]'),
      resolve: async () => new Response(null, { status: 302 }),
    });

    expect(JSON.stringify(SERVER_LOGS.records)).not.toContain(fileId);
    expect(SERVER_LOGS.records).toEqual([
      expect.objectContaining({ routeId: '/file/result/[id=uuid]', status: 302 }),
    ]);
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

  // `withDbErrorHandling` is handed no event, so this is `logger()` finding the request's own.
  test('503s an unreachable database, logging both lines under one request id', async () => {
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(anUnreachableDatabaseError());
    const event = anEvent();
    vi.mocked(getRequestEvent).mockReturnValue(event);

    try {
      await handle({ event, resolve: respond });
      expect.unreachable('handle should have thrown');
    } catch (thrown) {
      if (!isHttpError(thrown)) throw thrown;
      expect(thrown.status).toBe(503);
      expect(thrown.body.code).toBe('service_unavailable');
    }
    const requestId = expect.any(String);
    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Could not reach the database to load authorization',
        requestId,
        userId: A_USER_ID,
        err: expect.objectContaining({ code: 'ECONNREFUSED' }),
      },
      {
        level: 'info',
        msg: 'Request',
        requestId,
        method: 'GET',
        routeId: null,
        path: '/',
        status: 503,
        durationMs: expect.any(Number),
      },
    ]);
    expect(SERVER_LOGS.records[0]?.requestId).toBe(SERVER_LOGS.records[1]?.requestId);
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
    expect(SERVER_LOGS.records).toEqual([expect.objectContaining({ msg: 'Request', status: 500 })]);
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
  test('logs an unexpected failure, and tells the client none of it', async () => {
    const cause = new Error('password authentication failed for user "app"');

    const body = await handleError({ kind: 'unknown', error: cause, event: anEvent('/reports') });

    expect(SERVER_LOGS.records).toEqual([
      {
        level: 'error',
        msg: 'Unhandled server error',
        err: expect.objectContaining({ type: 'Error', message: cause.message }),
      },
    ]);
    expect(body).toEqual({ message: UNEXPECTED_ERROR_MESSAGE });
  });

  test('keeps the body of our own error(), code and all, without logging it', async () => {
    const body = await handleError({
      kind: 'app',
      error: { status: 403, message: 'Only an admin can do that', code: 'forbidden' },
      event: anEvent('/orgs/acme/settings'),
    });

    expect(body).toBeUndefined();
    expect(SERVER_LOGS.records).toEqual([]);
  });

  describe('an error from SvelteKit itself', () => {
    test('tags a 404 as not_found, without logging it', async () => {
      const body = await handleError({
        kind: 'framework',
        error: { status: 404, message: 'Not Found' },
        event: anEvent('/no-such-page'),
      });

      expect(body).toEqual({ code: 'not_found' });
      expect(SERVER_LOGS.records).toEqual([]);
    });

    test('keeps any other status as SvelteKit wrote it, without logging it', async () => {
      const body = await handleError({
        kind: 'framework',
        error: { status: 405, message: 'Method Not Allowed' },
        event: anEvent('/health'),
      });

      expect(body).toBeUndefined();
      expect(SERVER_LOGS.records).toEqual([]);
    });
  });
});
