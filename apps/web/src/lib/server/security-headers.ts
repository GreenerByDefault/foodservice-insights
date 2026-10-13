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

  // `kit.csp` in `vite.config.ts` sets a policy only on rendered pages, so its absence is what
  // marks every other response.
  const pagePolicy = response.headers.get('Content-Security-Policy');
  if (pagePolicy === null) {
    response.headers.set('Content-Security-Policy', NON_PAGE_POLICY);
  } else {
    response.headers.set('Content-Security-Policy', withSupabase(pagePolicy));
    // Relative, so the browser resolves it against the page it loaded. An absolute URL would come
    // from `event.url`, whose scheme behind a proxy is only as right as adapter-node's config.
    response.headers.set('Reporting-Endpoints', 'csp="/csp-report"');
  }
  return response;
}

/** Finished here rather than in `kit.csp`, because the Supabase URL varies by environment and the
 * build does not. */
function withSupabase(pagePolicy: string): string {
  const supabaseOrigin = new URL(requirePublicVar('PUBLIC_SUPABASE_URL')).origin;
  return pagePolicy
    .split('; ')
    .map((directive) =>
      directive.startsWith('connect-src ') ? `${directive} ${supabaseOrigin}` : directive,
    )
    .join('; ');
}
