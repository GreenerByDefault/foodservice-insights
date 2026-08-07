import type { UserId } from '@gbd/db';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as authorization from '$lib/server/auth/authorization';
import * as identify from '$lib/server/auth/identify';
import { closeDatabase } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { handle } from './hooks.server.ts';

// The hook's job is the wiring — what it does with an identity and an authorization lookup — so
// both are stubbed here. They are tested for real in `$lib/server/auth/authorization.test.ts`.
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

/** The parts of a request `handle` actually reads. */
function anEvent(pathname = '/'): RequestEvent {
  return { url: new URL(`http://localhost${pathname}`), locals: {} } as RequestEvent;
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

  test('treats an unreachable database as signed out rather than failing the request', async () => {
    vi.mocked(authorization.loadAuthorization).mockRejectedValue(new Error('connection refused'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = anEvent();

    const response = await handle({ event, resolve: respond });

    expect(response.status).toBe(200);
    expect(event.locals.auth).toBeNull();
    logged.mockRestore();
  });

  test('fails loudly when the identified user has no row, rather than 401ing silently', async () => {
    vi.mocked(authorization.loadAuthorization).mockResolvedValue(null);

    await expect(handle({ event: anEvent(), resolve: respond })).rejects.toThrow(/pnpm seed/);
  });
});
