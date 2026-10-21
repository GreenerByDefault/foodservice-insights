# Serve the app from insights.greenerbydefault.com

> **Status:** a spec. Today the web app is served from its App Platform starter domain
> (`<app>.ondigitalocean.app`). This plan puts it on `insights.greenerbydefault.com`, served by
> App Platform directly, with no edge of our own in front (`docs/architecture.md` § Hosting). The PR
> below deletes this file. [`production-sign-in.md`](production-sign-in.md) § Order of
> operations says where this sits among the other go-live plans.

## Context

GBD has two domains, both with DNS at Squarespace (`dig NS`, 2026-10-18). greenerbydefault.com is
the website: greenerbydefault.org redirects to www.greenerbydefault.com. greenerbydefault.org is
mail: it carries Google Workspace's DKIM, HubSpot's SPF include, and `p=reject` DMARC, which .com
lacks. The app follows that split. It lives at `insights.greenerbydefault.com` and sends as
`insights@greenerbydefault.org` ([`email-provider.md`](email-provider.md)). Nothing in this plan
touches .org.

Vendor facts, read from App Platform's docs on 2026-10-18:

- **A custom subdomain is one CNAME** at the DNS host, pointing at the app's starter domain. App
  Platform verifies it and issues the certificate itself. TXT verification is only for wildcards.
  DNS can take up to 72 hours to propagate, though Squarespace's usually takes minutes.
- **The spec carries the domain** as a `domains[]` entry with `type: PRIMARY`. `PRIMARY` alone does
  not redirect the starter domain; that takes an ingress rule whose `match.authority.exact` is the
  starter domain and whose `redirect.authority` is ours (`redirect_code` defaults to 302).
- **The docs match the starter domain with App Platform's `${STARTER_DOMAIN}` placeholder.** Our
  deploy renders every `${NAME}` from the GitHub Environment and fails on an unset one
  ([`.do/README.md`](../../.do/README.md)), so the spec must name the starter domain literally. It
  is a public hostname, so that costs nothing.
- **The app sees `Host: insights.greenerbydefault.com`**, because nothing sits between App
  Platform and the browser, so SvelteKit's CSRF check needs no `HOST_HEADER`.

## Decisions

### A subdomain of GBD's domain, served by App Platform directly

This plan's predecessor registered a dedicated domain, because Cloudflare's free plan runs DNS for
a whole zone and GBD's zone was not going to move. With Cloudflare rejected (`docs/architecture.md`
§ Hosting), nothing constrains the name. A subdomain costs nothing, reads as GBD's, and needs one
DNS record from them.

### The starter domain redirects to the domain, permanently

One canonical URL: a session is a cookie on a host, Supabase Auth has one Site URL, and emails link
to `SITE_URL`. The redirect is the ingress rule above, with `redirect_code: 301`, since a browser
that cached a 302 would keep asking. *Rejected: leaving the starter domain reachable.* Nothing
needs it.

### HSTS gains `includeSubDomains`

Nothing lives under `insights.greenerbydefault.com`, so the directive is free and closes the
subdomain hole [`security-headers.ts`](../../apps/web/src/lib/server/security-headers.ts) left
open "until the domain is known". `preload` stays out: getting a domain off the preload list takes
months, and a rename is still conceivable.

## Before PR 1: DNS and dashboards

1. **GBD adds the CNAME** in Squarespace's DNS for greenerbydefault.com: host `insights`, data the
   web app's starter domain (the web app's dashboard shows it; Squarespace appends the domain to
   the host, so the host is entered without `.greenerbydefault.com`). This is in the handoff doc
   GBD was sent along with the mail records from `email-provider.md`. It can go in before the PR:
   until the PR lands, the name resolves to App Platform, which answers for a domain it does not
   know with an error page that nobody has the URL for.
2. **Confirm it**: `dig +short CNAME insights.greenerbydefault.com` returns the starter domain.
3. **`SITE_URL` in the `production` GitHub Environment** becomes `https://insights.greenerbydefault.com`.
   Both specs read it. The web picks it up at PR 1's deploy; the worker only at its next dispatch,
   so result emails keep linking to the starter domain until then. Dispatch it once PR 1 is live.
4. **Supabase, Authentication → URL Configuration:** Site URL `https://insights.greenerbydefault.com`.
   Sign-in uses codes rather than links, so nothing redirects through it today; it is set so that
   GoTrue's defaults never point a user at localhost. No Redirect URLs are needed.

## PR 1 — serve from the domain

- **[`.do/web.yaml`](../../.do/web.yaml):** the `domains[]` entry, and the redirect rule from the
  starter domain, with a comment on the literal hostname saying why it is not `${STARTER_DOMAIN}`.
  The `DOMAIN_FAILED` alert is already there. The domain lives in the spec for the same reason
  everything else does: a domain added in the dashboard lasts until the next deploy.
- **`security-headers.ts`:** `max-age=31536000; includeSubDomains`, and its comment now says why
  `preload` stays out.
- **`docs/architecture.md` § Hosting**, two or three lines: users reach the web app at
  `insights.greenerbydefault.com`, a CNAME in GBD's Squarespace DNS to the app's starter domain,
  which redirects to it; App Platform terminates TLS; the domain is in the spec.
- Delete this plan.

Merging deploys the web. Then dispatch `deploy.yml` for the worker, for step 3.

## Verification

- `curl -sI https://insights.greenerbydefault.com/health/live` is a 200 with exactly one
  `Strict-Transport-Security` header, carrying `includeSubDomains`. The certificate is for
  `insights.greenerbydefault.com`.
- `curl -sI http://insights.greenerbydefault.com` redirects to `https://`, and
  `curl -sI https://<starter domain>` is a 301 to `https://insights.greenerbydefault.com`.
- A mutating request through the domain succeeds, such as creating an organization. A GET-only
  check would pass even with the CSRF check broken.
- An invite sent after the deploy links to the domain. After the worker dispatch, so does a
  result email.
