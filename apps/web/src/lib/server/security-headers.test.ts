import { describe, expect, test } from 'vitest';
import { applySecurityHeaders } from './security-headers.ts';

describe('applySecurityHeaders', () => {
  test('sets the full header set', () => {
    const response = applySecurityHeaders(new Response('ok'));

    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
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
});
