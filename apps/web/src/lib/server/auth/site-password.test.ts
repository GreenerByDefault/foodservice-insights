import type { Cookies } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  hasSiteSession,
  isSitePassword,
  readSiteSession,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_LIFETIME_SECONDS,
  signSiteSession,
  sitePassword,
} from './site-password.ts';

const env = vi.hoisted(() => ({ password: '' }));
vi.mock('#lib/server/env.js', () => ({ requirePrivateVar: () => env.password }));

const PASSWORD = 'correct-horse-battery';
const NOW = 1_800_000_000;

beforeEach(() => {
  env.password = PASSWORD;
});

describe('sitePassword', () => {
  test('is SITE_PASSWORD', () => {
    expect(sitePassword()).toBe(PASSWORD);
  });

  test('refuses one shorter than 12 characters', () => {
    env.password = 'eleven-char';

    expect(sitePassword).toThrow('SITE_PASSWORD is 11 characters; it must be at least 12');
  });
});

describe('isSitePassword', () => {
  test.each([
    ['the password', PASSWORD, true],
    ['another password', 'correct-horse-staple', false],
    ['a prefix of it', 'correct-horse', false],
    ['nothing', '', false],
  ])('%s is %s', (_, candidate, expected) => {
    expect(isSitePassword(candidate)).toBe(expected);
  });
});

describe('readSiteSession', () => {
  test('is the expiry of an unexpired session the password signed', () => {
    const value = signSiteSession(PASSWORD, NOW + 60);

    expect(readSiteSession(PASSWORD, value, NOW)).toBe(NOW + 60);
  });

  test('refuses an expired session', () => {
    const value = signSiteSession(PASSWORD, NOW);

    expect(readSiteSession(PASSWORD, value, NOW)).toBeNull();
  });

  test('refuses a session another password signed, so rotating the password signs everyone out', () => {
    const value = signSiteSession('the-previous-password', NOW + 60);

    expect(readSiteSession(PASSWORD, value, NOW)).toBeNull();
  });

  test('refuses an expiry moved without re-signing', () => {
    const signature = signSiteSession(PASSWORD, NOW - 60).split('.')[1];

    expect(readSiteSession(PASSWORD, `${NOW + 60}.${signature}`, NOW)).toBeNull();
  });

  test.each(['', 'garbage', `${NOW + 60}`, `${NOW + 60}.`, `.${NOW}`, '1e12.abc', 'a.b.c'])(
    'refuses the malformed %j',
    (value) => {
      expect(readSiteSession(PASSWORD, value, NOW)).toBeNull();
    },
  );

  test('refuses a valid session with anything appended', () => {
    const value = signSiteSession(PASSWORD, NOW + 60);

    expect(readSiteSession(PASSWORD, `${value}.extra`, NOW)).toBeNull();
  });
});

describe('hasSiteSession', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function anEvent(cookie: string | undefined) {
    return {
      cookies: { get: vi.fn(() => cookie), set: vi.fn(), delete: vi.fn() } as unknown as Cookies,
      setHeaders: vi.fn(),
    };
  }

  test('is false without the cookie, and touches nothing', () => {
    const event = anEvent(undefined);

    expect(hasSiteSession(event)).toBe(false);
    expect(event.cookies.get).toHaveBeenCalledWith(SITE_SESSION_COOKIE_NAME);
    expect(event.cookies.set).not.toHaveBeenCalled();
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });

  test('is true for a session with more than half its life left, without reissuing it', () => {
    const event = anEvent(signSiteSession(PASSWORD, NOW + SITE_SESSION_LIFETIME_SECONDS / 2 + 1));

    expect(hasSiteSession(event)).toBe(true);
    expect(event.cookies.set).not.toHaveBeenCalled();
    expect(event.setHeaders).not.toHaveBeenCalled();
  });

  test('reissues a session past half its life for a full lifetime, uncacheably', () => {
    const event = anEvent(signSiteSession(PASSWORD, NOW + SITE_SESSION_LIFETIME_SECONDS / 2 - 1));

    expect(hasSiteSession(event)).toBe(true);
    expect(vi.mocked(event.cookies.set).mock.calls).toStrictEqual([
      [
        SITE_SESSION_COOKIE_NAME,
        signSiteSession(PASSWORD, NOW + SITE_SESSION_LIFETIME_SECONDS),
        { path: '/', maxAge: SITE_SESSION_LIFETIME_SECONDS },
      ],
    ]);
    expect(event.setHeaders).toHaveBeenCalledWith({
      'cache-control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    });
  });

  test('is false for a session it refuses, and clears it', () => {
    const event = anEvent(signSiteSession('the-previous-password', NOW + 60));

    expect(hasSiteSession(event)).toBe(false);
    expect(event.cookies.delete).toHaveBeenCalledWith(SITE_SESSION_COOKIE_NAME, { path: '/' });
    expect(event.cookies.set).not.toHaveBeenCalled();
  });
});
