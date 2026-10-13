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

/** For everything that is not a page: `/api`, polls, `__data.json`, redirects, `/health`. */
const NON_PAGE_POLICY = "default-src 'none'; frame-ancestors 'none'";

/** `supabaseOrigin` is where the browser signs in, or null in `placeholder` mode. */
export function applySecurityHeaders(response: Response, supabaseOrigin: string | null): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(response.headers.get('Content-Security-Policy'), supabaseOrigin),
  );
  return response;
}

/** `pagePolicy` is what `kit.csp` in `vite.config.ts` set, which it does only on a rendered page, so
 * its absence is what marks every other response. */
export function contentSecurityPolicy(
  pagePolicy: string | null,
  supabaseOrigin: string | null,
): string {
  if (pagePolicy === null) return NON_PAGE_POLICY;
  if (supabaseOrigin === null) return pagePolicy;
  return pagePolicy
    .split('; ')
    .map((directive) =>
      directive.startsWith('connect-src ') ? `${directive} ${supabaseOrigin}` : directive,
    )
    .join('; ');
}
