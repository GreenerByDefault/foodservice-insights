import { requirePublicVar } from './env.ts';

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

export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(response.headers.get('Content-Security-Policy')),
  );
  return response;
}

/** `kit.csp` in `vite.config.ts` sets a policy only on rendered pages, so its absence is what
 * marks every other response. A page's is finished here, because the Supabase URL varies by
 * environment and the build does not. */
function contentSecurityPolicy(pagePolicy: string | null): string {
  if (pagePolicy === null) return NON_PAGE_POLICY;
  const supabaseOrigin = new URL(requirePublicVar('PUBLIC_SUPABASE_URL')).origin;
  return pagePolicy
    .split('; ')
    .map((directive) =>
      directive.startsWith('connect-src ') ? `${directive} ${supabaseOrigin}` : directive,
    )
    .join('; ');
}
