import { describe, expect, test } from 'vitest';
import { applySecurityHeaders, contentSecurityPolicy } from './security-headers.ts';

const SUPABASE_ORIGIN = 'https://abcdefgh.supabase.co';

describe('applySecurityHeaders', () => {
  test('sets the full header set', () => {
    const response = applySecurityHeaders(new Response('ok'), null);

    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
  });

  test('replaces a value the route already set', () => {
    const response = applySecurityHeaders(
      new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } }),
      null,
    );

    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('contentSecurityPolicy', () => {
  const PAGE_POLICY = "default-src 'self'; connect-src 'self'; frame-ancestors 'none'";

  test('lets a page reach Supabase', () => {
    expect(contentSecurityPolicy(PAGE_POLICY, SUPABASE_ORIGIN)).toBe(
      `default-src 'self'; connect-src 'self' ${SUPABASE_ORIGIN}; frame-ancestors 'none'`,
    );
  });

  test('leaves a page alone in placeholder mode', () => {
    expect(contentSecurityPolicy(PAGE_POLICY, null)).toBe(PAGE_POLICY);
  });

  test('loads nothing, and allows no framing, for anything that is not a page', () => {
    expect(contentSecurityPolicy(null, SUPABASE_ORIGIN)).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });
});
