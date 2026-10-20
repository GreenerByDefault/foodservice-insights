/** The site password: how `placeholder` mode signs a visitor in until there is an email provider.
 * Deleted with that mode (`.claude/plans/production-sign-in.md` PR 2).
 *
 * Whoever knows `SITE_PASSWORD` is the placeholder user, a superadmin, so this password is all that
 * stands between the internet and every organization's data. Nothing rate-limits a guess; its
 * length is what makes guessing hopeless.
 *
 * The session is a cookie holding an expiry and an HMAC of it, keyed by the password: nothing is
 * stored, and rotating the password signs every browser out.
 *
 * *Rejected: HTTP Basic auth,* which hides the marketing page, cannot sign out, and runs none of
 * the signed-out paths that `supabase` mode will.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { requirePrivateVar } from '#lib/server/env.js';

export const SITE_SESSION_COOKIE_NAME = 'fsi-site-session';

export const SITE_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export const MIN_SITE_PASSWORD_LENGTH = 12;

export function sitePassword(): string {
  const password = requirePrivateVar('SITE_PASSWORD');
  if (password.length < MIN_SITE_PASSWORD_LENGTH) {
    throw new Error(
      `SITE_PASSWORD is ${password.length} characters; it must be at least ` +
        `${MIN_SITE_PASSWORD_LENGTH}, because nothing else slows down a guess.`,
    );
  }
  return password;
}

export function isSitePassword(candidate: string): boolean {
  // Digests, so the comparison is constant-time and `timingSafeEqual` gets equal lengths.
  return timingSafeEqual(sha256(candidate), sha256(sitePassword()));
}

export function signSiteSession(password: string, expiresAt: number): string {
  return `${expiresAt}.${mac(password, expiresAt)}`;
}

/** When `value` expires, in epoch seconds, or null unless it is an unexpired session that
 * `password` signed. */
export function readSiteSession(password: string, value: string, now: number): number | null {
  const [expiry, signature, ...rest] = value.split('.');
  if (expiry === undefined || signature === undefined || rest.length > 0) return null;
  if (!/^\d+$/.test(expiry)) return null;

  const expiresAt = Number(expiry);
  const expected = Buffer.from(mac(password, expiresAt));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return expiresAt > now ? expiresAt : null;
}

/** Whether this request carries a live session. One past half its lifetime is reissued, so a
 * visitor who keeps coming back stays signed in; one that fails is cleared. */
export function hasSiteSession(event: Pick<RequestEvent, 'cookies' | 'setHeaders'>): boolean {
  const value = event.cookies.get(SITE_SESSION_COOKIE_NAME);
  if (value === undefined) return false;

  const password = sitePassword();
  const now = nowSeconds();
  const expiresAt = readSiteSession(password, value, now);
  if (expiresAt === null) {
    endSiteSession(event.cookies);
    return false;
  }

  if (expiresAt - now < SITE_SESSION_LIFETIME_SECONDS / 2) {
    writeSiteSession(event.cookies, password, now);
    // Runs before `resolve`, on any route, so a shared cache could otherwise hand this cookie, and
    // with it the placeholder user, to the next visitor. The same headers `identify.ts` writes.
    event.setHeaders({
      'cache-control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    });
  }
  return true;
}

export function startSiteSession(cookies: Cookies): void {
  writeSiteSession(cookies, sitePassword(), nowSeconds());
}

export function endSiteSession(cookies: Cookies): void {
  cookies.delete(SITE_SESSION_COOKIE_NAME, { path: '/' });
}

/** `httpOnly`, `secure`, and `sameSite` are left to SvelteKit's defaults: unlike the Supabase
 * cookie, nothing in the browser reads this one. */
function writeSiteSession(cookies: Cookies, password: string, now: number): void {
  const expiresAt = now + SITE_SESSION_LIFETIME_SECONDS;
  cookies.set(SITE_SESSION_COOKIE_NAME, signSiteSession(password, expiresAt), {
    path: '/',
    maxAge: SITE_SESSION_LIFETIME_SECONDS,
  });
}

function mac(password: string, expiresAt: number): string {
  return createHmac('sha256', password).update(`site-session:${expiresAt}`).digest('base64url');
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
