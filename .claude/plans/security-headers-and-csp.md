# Security headers and CSP

## Context

[`REQUIREMENTS.md`](../../REQUIREMENTS.md) § Security asks for a CSP and HSTS. Both are enforced
now; what is left is hearing about violations once real browsers hit the policy.

What exists, checked 2026-10-12:

- **The page policy** is `kit.csp`, passed to `sveltekit({…})` in
  [`vite.config.ts`](../../apps/web/vite.config.ts) — SvelteKit 3 has no `svelte.config.js`. It is
  serialized at build time and sent only on rendered pages
  (`kit/src/runtime/server/page/render.js:594`).
- **`applySecurityHeaders(response)`** in
  [`lib/server/security-headers.ts`](../../apps/web/src/lib/server/security-headers.ts) runs on every
  response that passes through `handle`. It tells the two kinds of response apart by whether
  SvelteKit already set a `content-security-policy`:
  - A page keeps its policy, with the origin of `PUBLIC_SUPABASE_URL` added to `connect-src`. That
    variable is required in every auth mode (`assertConfigured`).
  - Everything else — `/api`, polls, `__data.json`, redirects, `/health` — gets
    `default-src 'none'; frame-ancestors 'none'`. A JSON body has nothing in it to violate, so this
    policy never reports.
- **The browser fixtures already fail on any violation.**
  [`packages/browser-testing/src/fixtures.ts`](../../packages/browser-testing/src/fixtures.ts)
  records `securitypolicyviolation` events in `context` and `users.contextFor`, so every e2e and
  screenshot test asserts none fired. Reports are for production, not for tests.

## Decisions

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
- **Only pages report.** `Reporting-Endpoints` goes on the same responses that keep a page policy,
  so it belongs beside the page branch in `security-headers.ts`. Its value needs the request's
  origin, which `applySecurityHeaders` is not given today.
- **Reports don't send from `host.docker.internal`**, which is not a trustworthy origin. The
  screenshot browser reaches the app there, which is one more reason no test relies on a report.
- *Rejected: rate-limiting the endpoint.* Any unauthenticated URL already costs an access line,
  and reports at most double that. Cloudflare is the layer for floods (REQUIREMENTS § Abuse
  limits).
- *Rejected: a hosted collector such as report-uri.com.* It is a new vendor for what one log line
  and a saved query already do. The same reasoning rejected Sentry in
  [`observability-vendors.md`](observability-vendors.md).

## PRs

### PR 1 — Violation reports

- **Parsing:** `apps/web/src/lib/server/csp-report.ts` turns either body format into the reduced
  records, or returns a parse failure. It is pure.
- **The route:** `apps/web/src/routes/csp-report/+server.ts`.
  - 413 for a missing or too-large `content-length`, 400 for a malformed body, 204 otherwise.
  - One `warn` line per surviving report.
- **Policy:** add `'report-uri': ['/csp-report']` and `'report-to': ['csp']` to `kit.csp`. On page
  responses, send `Reporting-Endpoints: csp="<event.url.origin>/csp-report"`, passing the origin
  from `handle` into `applySecurityHeaders`.
- **Access log:** add the route to `POLLED_ROUTES` in `hooks.server.ts`, and reword its comment
  ("Called on a timer rather than by a person") so it covers callers that aren't people.
- **Tests:**
  - Parsing: both formats, extension filtering, the URL reduction, malformed input.
  - The route: 413, 400, and 204 with `SERVER_LOGS` checked by `toEqual`.
  - `security-headers.test.ts`: `Reporting-Endpoints` on a page, and not on anything else.
- **Manual check in dev:** in Chrome and Firefox, run `fetch('https://example.com')` in the
  devtools console and see the `warn` line. Chromium batches its reports, so allow up to a
  minute.
  - While in Firefox, also do the dev check the CSP's own PR could not run there: sign in against
    the dev Supabase, open and close a dialog (scrolling comes back), and make an HMR edit. Its
    headless Firefox would not launch on macOS 27; Chromium and WebKit passed all three.

## Verification

- **Each PR:** run `pnpm lint && pnpm check && pnpm test` from the repo root. `pnpm test` runs
  Playwright, whose fixtures fail any page that violates the policy.
- **Headers by hand:** with `pnpm dev:web` running, `curl -sI http://localhost:5173/` shows
  `Reporting-Endpoints` and the reporting directives, and `curl -sI http://localhost:5173/health`
  shows neither.
- **The manual browser checks** listed under PR 1.
