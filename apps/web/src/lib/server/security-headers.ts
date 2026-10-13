/** Set on every response that passes through `handle`. Static files (adapter-node answers them
 * before `handle` runs) and `error.html` go out without them.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // Kept beside `frame-ancestors` for older browsers.
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Browsers ignore it over `http:`, so dev and e2e are unaffected. No `includeSubDomains` or
  // `preload` until the domain is known.
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
