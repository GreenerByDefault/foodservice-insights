import { describe, expect, test, vi } from 'vitest';
import { applySecurityHeaders } from './security-headers.ts';

vi.mock('./env.ts', () => ({ requirePublicVar: () => 'https://abcdefgh.supabase.co/' }));

describe('applySecurityHeaders', () => {
  test('sets the full header set, with a policy that loads nothing on anything but a page', () => {
    const response = applySecurityHeaders(new Response('ok'));

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
    );

    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  test("lets a page's policy reach Supabase", () => {
    const response = applySecurityHeaders(
      new Response('<html>', {
        headers: {
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; base-uri 'none'",
        },
      }),
    );

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; connect-src 'self' https://abcdefgh.supabase.co; base-uri 'none'",
    );
  });
});
