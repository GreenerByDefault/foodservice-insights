# Our domain, behind Cloudflare

## Context

Cloudflare's part in the product comes from a few places:

- [`REQUIREMENTS.md`](../../REQUIREMENTS.md) § Abuse limits puts Cloudflare's free plan in front of
  the web app for DDoS protection and possibly geo-restriction.
- § Metrics reads users' countries from Cloudflare's dashboard.
- [`/csp-report`](../../apps/web/src/routes/csp-report/+server.ts) relies on Cloudflare to absorb
  floods.

Today the web app is served from its App Platform starter domain (`<app>.ondigitalocean.app`).
This plan moves users to our own domain, with Cloudflare in front.

Vendor facts, read 2026-10-14:

- **Cloudflare's free plan only supports a full setup**, where Cloudflare runs DNS for the whole
  domain. Proxying a single subdomain while the rest of the domain's DNS stays elsewhere needs
  Business (partial setup) or Enterprise (subdomain setup)
  ([zone setups](https://developers.cloudflare.com/dns/zone-setups/)).
- **DigitalOcean's documented way to put a CDN in front of an app is to not add the domain to
  App Platform at all**
  ([external CDN](https://docs.digitalocean.com/products/app-platform/how-to/configure-external-cdn/)).
  The CDN terminates TLS and connects to the starter domain over HTTPS, and it "must not forward
  the original `Host` header". If the custom domain is also added to the app, App Platform's
  certificate renewal fails.
- **Cloudflare's free plan can't override `Host` or SNI.** Origin Rules offer both only on
  Enterprise ([origin rules](https://developers.cloudflare.com/rules/origin-rules/)). A proxied
  `CNAME` pointing at the starter domain would reach DigitalOcean with `Host` set to our domain,
  which is exactly what its guidance rules out.
- **A Worker can do it on the free plan.** A Worker that re-requests each URL from the starter
  domain sends that domain's name as both `Host` and SNI. The free tier allows 100,000 requests a
  day. Cloudflare's security rules run before the Worker, so WAF and rate-limiting rules still
  apply.
- **The free plan includes** 5 custom WAF rules, which can match on country, and 1 rate-limiting
  rule.
- **The app already sends HSTS**
  ([`security-headers.ts`](../../apps/web/src/lib/server/security-headers.ts)), without
  `includeSubDomains` or `preload` until the domain is known.
- **No email records go in this zone.** Mail is sent as `insights@greenerbydefault.org`, so
  Postmark's DKIM and Return-Path records go on greenerbydefault.org, whose DNS stays at
  Squarespace. [`email-provider.md`](email-provider.md) owns them.

Two consequences shape the design:

- **The app will see `Host: <app>.ondigitalocean.app` while the browser's `Origin` is our
  domain.** SvelteKit's CSRF check would then reject every form submission and other mutating
  request, while every GET still works. adapter-node takes the host from a different header when
  `HOST_HEADER` names one, so the Worker passes our domain along in `X-Forwarded-Host`.
- **The starter domain stays reachable directly**, bypassing Cloudflare and any rules set there.
  App Platform can redirect its starter domain to a custom one, but here the starter domain is
  the Worker's origin, so the redirect would loop. DDoS protection survives the bypass, because App
  Platform's own edge is Cloudflare. A geo-restriction or rate limit does not.

## Decisions

### A domain of the app's own

On the free plan, Cloudflare runs DNS for the entire domain the app lives under. If the app were a
subdomain of GBD's existing domain, all of GBD's DNS would move to Cloudflare, including their
website and staff email. Register a dedicated domain instead (Cloudflare Registrar sells domains
at cost). A subdomain would cost nothing extra only if GBD's domain were already on Cloudflare,
and it is not: its DNS is at Squarespace (`dig NS greenerbydefault.org`, 2026-10-14).
**Open:** the name.

### A Worker in front of the starter domain

Our domain is attached to a Worker as a Workers Custom Domain, and appears nowhere in App Platform.
For each request, the Worker:

1. Rewrites the URL's host to the starter domain.
2. Sets `X-Forwarded-Host` to our domain.
3. Fetches the result and returns the response unchanged.

It is about a dozen lines. Its source lives in the repo as `cloudflare/worker.js`, and is deployed
by hand with `wrangler deploy`. *Considered, not done: deploying it from `deploy.yml`.* It will
almost never change, and deploying from CI would need a Cloudflare token in the `production`
Environment.

*Rejected: a plain proxied `CNAME`.* Our domain would reach DigitalOcean as the `Host`, against its
guidance, and fixing that needs an Enterprise-only Origin Rule.

*Rejected: adding the domain to App Platform, with the proxy off until the certificate is issued.*
Community answers describe this route, but DigitalOcean's docs say certificate renewal then fails.
That would show up as an outage months later.

### Not yet: refusing traffic that bypassed Cloudflare

The usual fix for the bypass is a secret header that the Worker adds and `handle` checks.
*Considered, not done:* it only protects rules we do not have yet. Add it in the same PR as the
first geo-restriction or rate-limiting rule. Until then, a request that skips Cloudflare reaches
nothing Cloudflare would have stopped.

### Cloudflare settings

- **Always Use HTTPS** on.
- **HSTS off in Cloudflare.** The app sends its own, so the response would otherwise carry two.
- **No geo-restriction at launch.** The requirement says "potentially". Adding one later takes a
  single custom rule plus the bypass check above.
- **Workers Paid ($5/month)** only if traffic ever approaches 100,000 requests a day. A
  five-minute report polled every 10 seconds is about 30 requests.

## Before PR 1: the dashboard

1. Register the domain with Cloudflare Registrar, on the free plan.
2. Turn on the settings above.

## PR 1 — serve from our domain

- **`cloudflare/worker.js`**, as described above, with a header comment saying why it exists:
  the `Host` rule, and that the free plan can't override `Host`. Deploy it and attach our domain
  as its Custom Domain.
- **The app specs from the hosting plan:**
  - `SITE_URL=https://<domain>` in both specs, since the worker builds email links too.
  - `HOST_HEADER=x-forwarded-host` in the web app's spec.
  - **Open:** confirm that App Platform's ingress passes `X-Forwarded-Host` through rather than
    overwriting it. If it overwrites it, have the Worker send a header with a name of our own,
    and point `HOST_HEADER` at that.
- **`security-headers.ts`:** add `includeSubDomains` if the domain is dedicated to the app. Leave
  `preload` out, because getting a domain off the preload list takes months.
- **`ARCHITECTURE.md` § Hosting:** a few lines saying that users reach the app through a Cloudflare
  Worker at our domain, that its origin is the starter domain (App Platform doesn't know our domain
  exists), and that the starter domain is still reachable directly.
- Delete this plan.

## Verification

- A mutating request through our domain succeeds, such as creating an organization. A GET-only
  check would pass even with `HOST_HEADER` wrong.
- `curl -sI https://<domain>` shows exactly one `Strict-Transport-Security` header, and `http://`
  redirects to `https://`.
- An email sent after the switch links to our domain, not the starter domain.
- Cloudflare's dashboard shows visitors by country.
