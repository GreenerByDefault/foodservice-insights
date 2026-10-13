# Security headers and CSP

## Context

[`REQUIREMENTS.md`](../../REQUIREMENTS.md) § Security asks for a CSP and HSTS.
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Auth still marks the CSP **Open**. Here it matters
more than usual: the Supabase session cookie (`fsi-auth`) cannot be `HttpOnly`, because the
browser client reads it to sign out. That makes `script-src` the only thing standing between an
XSS and a stolen session. Nothing is deployed yet, so this plan lands everything the code can own
now and leaves only settings that depend on the domain or the edge.

What exists, checked 2026-10-12:

- **`applySecurityHeaders`** in
  [`lib/server/security-headers.ts`](../../apps/web/src/lib/server/security-headers.ts) sets the
  seven headers of § The other headers on every response that passes through `handle`, which
  calls it from `applyHeaders` in [`hooks.server.ts`](../../apps/web/src/hooks.server.ts).
  `security-headers.test.ts` asserts the full set, and `hooks.server.test.ts` checks the wiring.
- **There is no separate API server.** Everything is SvelteKit and passes through `handle`:
  - `/api/*` and the two `*/poll` routes
  - `/file/*`, which 302s to a signed storage URL
  - `/health`
  - `__data.json`
- **The browser contacts one other origin: Supabase Auth**, and only when
  `PUBLIC_AUTH_MODE=supabase`. It uses `fetch` only, from
  [`lib/auth/browser.ts`](../../apps/web/src/lib/auth/browser.ts).
  - There are no analytics, CDNs, iframes, OAuth flows or realtime sockets.
  - Inter is self-hosted through fontsource.
  - Downloads are top-level navigations through the 302, and uploads go to our own origin.
- **SvelteKit 3 has no `svelte.config.js`.** `kit.csp` is passed to `sveltekit({…})` in
  [`vite.config.ts`](../../apps/web/vite.config.ts).
  - It is serialized at build time.
  - It is sent only on page renders (`kit/src/runtime/server/page/render.js:594`).
  - `handle` can still edit that header after `resolve`.

## Decisions

### Two policies, told apart by whether SvelteKit rendered a page

`kit.csp` sets its header only on rendered pages, so `handle` needs no list of routes:

- A response that already carries `content-security-policy` is a page. Its policy is finished at
  runtime (below).
- Every other response gets `default-src 'none'; frame-ancestors 'none'`. That covers `/api`,
  polls, `__data.json`, `/file` redirects, `/health`, and redirects from `load`. Under this policy
  a JSON body loads nothing, and no site can frame it.

### The page policy

These directives are fixed at build time in `kit.csp`. `mode` stays at `'auto'`, which means
nonces, since nothing is prerendered.

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | |
| `script-src` | `'self'` + SvelteKit's nonce | The nonce covers SvelteKit's inline hydration script. |
| `style-src` | `'self' 'unsafe-inline'` | bits-ui writes `style` attributes during SSR (the sr-only radio inputs in `upload-form`/`invite-form`) and through `setAttribute` (the scroll-lock reset in dialogs and menus). Neither can carry a nonce. |
| `img-src` | `'self' data:` | Vite inlines the 811-byte `favicon.svg` as a `data:` URI. |
| `connect-src` | `'self'` + the Supabase origin, added at runtime | |
| `worker-src` | `blob:` | `read-excel-file` → fflate unzips any workbook entry of 512 KiB or more in a `blob:` worker (`fflate/esm/browser.js:2620`). Uploads go up to 10 MB, so this is an ordinary case. |
| `object-src` | `'none'` | |
| `base-uri` | `'none'` | |
| `form-action` | `'self'` | All seven forms submit through `onsubmit` and have no `action`. |
| `frame-ancestors` | `'none'` | |

PR 2 adds `report-uri` and `report-to`.

**At runtime**, `handle` adds the Supabase origin to `connect-src` in `supabase` mode. The origin
is `new URL(requirePublicVar('PUBLIC_SUPABASE_URL')).origin`. In placeholder mode, which is how
production launches, `connect-src` stays `'self'`.

**Left out: `upgrade-insecure-requests`.** It would upgrade the `http://127.0.0.1` Supabase URL in
dev and e2e. In production, HSTS covers the same ground, and we load no `http:` subresources.

- *Rejected: a nonce-only `style-src`.* It breaks the bits-ui cases above, and neither can be
  given a nonce. Injected CSS is far less dangerous than injected script, and `script-src` is what
  protects the cookie.
- *Rejected: `'strict-dynamic'`.* `'self'` is already safe here, because nothing on our origin
  that a user controls can run as script:
  - Uploads live in Supabase Storage.
  - JSON responses carry `nosniff`, which stops a browser from executing them.
- *Rejected: putting the Supabase origin in `kit.csp`.* That would bake one environment into the
  image, which `ARCHITECTURE.md` § Deployments › Images forbids.
- *Rejected: building the whole page policy in `handle`, without `kit.csp`.* SvelteKit only puts
  a nonce on its inline hydration script when `kit.csp` configures `script-src`.
- *Rejected: proxying Supabase Auth through our origin so `connect-src` stays `'self'`.* That is
  a proxy to keep one origin out of a header.
- *Rejected: a Report-Only phase before enforcing.* Before launch there are no users for a false
  positive to hurt. The e2e fixture in PR 1 enforces the policy on every page the suite visits,
  and reports keep arriving under enforcement.

### The other headers

`applySecurityHeaders` sets these four on every response, besides the three kept below:

| Header | Value | Note |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000` | Set by the app, not Cloudflare's HSTS toggle, so the response doesn't carry two. Browsers ignore it over `http:`, so dev and e2e are unaffected. `includeSubDomains`/`preload` wait until the domain is known. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | Features we never use. |
| `Cross-Origin-Opener-Policy` | `same-origin` | No popups and no OAuth windows. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Nothing embeds our responses cross-origin, and emails load no images from us. |

`X-Frame-Options`, `nosniff` and `Referrer-Policy` stay. `X-Frame-Options` is kept for older
browsers, because `frame-ancestors` supersedes it in newer ones. `X-XSS-Protection` is not added,
because browsers removed the auditor it controlled.

### Responses that still go out without these headers (accepted)

- **Static files:** `/_app/immutable/*`, the favicons and the fonts. adapter-node serves them
  before `handle` runs. A CSP has no effect on scripts, styles, fonts or images loaded as
  subresources. HSTS covers the whole host once any response has set it.
- **`error.html`**, when `handle` itself throws (the 503 and 500 paths in auth).
- **SvelteKit's CSRF rejection.**

The last two are static pages with no user content, so there is nothing for these headers to
protect.

### Violation reports

- **The endpoint:** `POST /csp-report`. It only logs, at `warn` as `CSP violation`, through the
  existing pino → Better Stack path.
- **It accepts both report formats:**
  - `report-uri` sends `application/csp-report` (Firefox and Safari).
  - `report-to`, via a `Reporting-Endpoints` header, sends `application/reports+json` (Chromium).

  Neither is a form content type, so SvelteKit's CSRF origin check does not apply
  (`kit/src/runtime/server/csrf.js`).
- **Each report is cut down before it is logged:**
  - The blocked URL becomes its origin, or the keyword (`inline`, `eval`) when there is no URL.
  - The document URL becomes its path.
  - Reports from browser extensions are dropped (`chrome-extension:`, `moz-extension:`,
    `safari-web-extension:`). They make up most of the noise in real-world reports.
- **Limits and logging:** a 413 when `content-length` is missing or over 64 KiB. The route's
  access line goes at `debug`, because the `warn` line already records the visit.
- **The API policy reports nothing**, since a JSON response has nothing in it to violate.
- *Rejected: rate-limiting the endpoint.* Any unauthenticated URL already costs an access line,
  and reports at most double that. Cloudflare is the layer for floods (REQUIREMENTS § Abuse
  limits).
- *Rejected: a hosted collector such as report-uri.com.* It is a new vendor for what one log line
  and a saved query already do. The same reasoning rejected Sentry in
  [`observability-vendors.md`](observability-vendors.md).

### Local development

- **`vite dev` serves the same `kit.csp`**, so dev enforces what production does, and a
  violation shows up in the console while you build. SvelteKit adds `'unsafe-inline'` to
  `style-src` in dev for Vite's injected `<style>`; we already have it.
- **Supabase is allowed through the same runtime path as production.** The dev stack
  (`http://127.0.0.1:55321`) and the test stack (`:65321`) reach `connect-src` from
  `PUBLIC_SUPABASE_URL`.
- **HMR's WebSocket** uses the same host and port. In CSP Level 3, `'self'` matches `ws:` for the
  same host and port. Verify this in Chrome, Firefox and Safari in PR 1. If one of them blocks
  it, add `ws:` to `connect-src` in dev only.
- **There is no switch to turn the CSP off.**
- **e2e runs the production build** (`node start.js`) over `http:` on a random port. The
  screenshot browser reaches it at `host.docker.internal`. `'self'` covers both. Reports don't
  send from `host.docker.internal`, which is not a trustworthy origin, and no test relies on
  them.

## PRs

### PR 1 — The CSP

- **`vite.config.ts`:** `sveltekit({ csp: { directives } })`. Comment only the directives the
  table had to explain: `style-src`, `img-src` and `worker-src`.
- **`security-headers.ts`:** add a pure function that takes the response's existing policy (or none)
  and the Supabase origin (or null).
  - For a page, it adds the origin to `connect-src`.
  - For anything else, it returns the API policy.
- **`hooks.server.ts`:** derive the Supabase origin from `authMode()`, and read
  `requirePublicVar` only in `supabase` mode.
- **A CSP-violation fixture** in
  [`packages/browser-testing/src/fixtures.ts`](../../packages/browser-testing/src/fixtures.ts):
  - The `context` fixture, and `users.contextFor`, record `securitypolicyviolation` events through
    `exposeBinding` plus `addInitScript`.
  - After `use`, it asserts `toEqual([])` over `{ effectiveDirective, blockedURI, documentURI }`,
    so a failure names the directive.
  - This covers every e2e and screenshot test. The auth e2e covers the browser's calls to
    Supabase.
- **A large-workbook e2e** in
  [`new-report.e2e.ts`](../../apps/web/e2e/new-report/new-report.e2e.ts):
  - Build the workbook with `aWorkbook`
    ([`lib/reports/excel/testing`](../../apps/web/src/lib/reports/excel/testing/workbook.ts)).
    Its sheet XML must be past fflate's 512 KiB worker threshold and still under the upload limit.
  - Confirm once that the test fails without `worker-src blob:`.
- **Unit tests:** the policy function, plus `hooks.server.test.ts` checking that a page response
  gets the origin and a JSON response gets the API policy.
- **Manual check in dev,** in Chrome, Firefox and Safari:
  - Open and close a dialog. Scrolling should come back.
  - Sign in against the dev Supabase.
  - Make an HMR edit.
- **Docs:** in `ARCHITECTURE.md` § Auth, replace the **Open:** CSP paragraph with the decision and
  its *Rejected* bullets. Check that
  [`apps/web/README.md`](../../apps/web/README.md#auth)'s pointer to it still reads right.

### PR 2 — Violation reports

- **Parsing:** `apps/web/src/lib/server/csp-report.ts` turns either body format into the reduced
  records, or returns a parse failure. It is pure.
- **The route:** `apps/web/src/routes/csp-report/+server.ts`.
  - 413 for a missing or too-large `content-length`, 400 for a malformed body, 204 otherwise.
  - One `warn` line per surviving report.
- **Policy:** add `'report-uri': ['/csp-report']` and `'report-to': ['csp']` to `kit.csp`. On page
  responses, send `Reporting-Endpoints: csp="<event.url.origin>/csp-report"`.
- **Access log:** add the route to the access log's `debug` set in `hooks.server.ts`, and reword
  that set's comment so it covers callers that aren't people.
- **Tests:**
  - Parsing: both formats, extension filtering, the URL reduction, malformed input.
  - The route: 413, 400, and 204 with `SERVER_LOGS` checked by `toEqual`.
- **Manual check in dev:** in Chrome and Firefox, run `fetch('https://example.com')` in the
  devtools console and see the `warn` line. Chromium batches its reports, so allow up to a
  minute.

## Verification

- **Each PR:** run `pnpm lint && pnpm check && pnpm test` from the repo root.
  `pnpm test` runs Playwright, so from PR 1 on the violation fixture checks every page the suite
  visits.
- **Headers by hand:** with `pnpm dev:web` running:
  - `curl -sI http://localhost:5173/` shows the page policy, and in `supabase` mode the Supabase
    origin in `connect-src`.
  - `curl -sI http://localhost:5173/health` shows `default-src 'none'; frame-ancestors 'none'`.
- **The manual browser checks** listed under PR 1 and PR 2.
