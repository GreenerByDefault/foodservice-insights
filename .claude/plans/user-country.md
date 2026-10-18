# Country of users

> **Status:** a spec for a nice-to-have. `REQUIREMENTS.md` § Metrics wants to know which countries
> users are in, in a privacy-preserving form, and there is no edge dashboard to read it from
> (`ARCHITECTURE.md` § Hosting). Nothing schedules this: build it once the metrics pipe
> ([`metrics-pipeline.md`](metrics-pipeline.md)) is up and someone wants the panel. The PR
> deletes this file.

## Context

- The host passes none of its edge's geolocation headers to the app. The app gets the visitor's
  address as `do-connecting-ip` and nothing about where it is (2026-10-18).
- Every browser reports its own time zone as an IANA name, such as `America/Chicago`, through
  `Intl.DateTimeFormat().resolvedOptions().timeZone`. IANA's `zone.tab` maps each zone to one ISO
  3166 country, and its `backward` file maps the old names browsers still report, such as
  `Asia/Calcutta`, to current ones.
- Supabase Auth already records each session's address and user agent in `auth.sessions`. That is
  its processing, not ours, and nothing here reads it.
- Sign-in happens between the browser and Supabase Auth; our server first sees a user when the
  `(app)` layout loads (`apps/web/README.md` § Auth).

## Decisions

### The device's time zone, mapped to a country

The browser sends its time zone once after sign-in, the server maps it to a country, and stores
the two-letter code on the user. That answers the question GBD is asking, where its users are,
rather than where one request came from, and it does so without reading or keeping an IP address
for it, without a database to refresh, and without a vendor.

The accuracy is what a nice-to-have needs. It is wrong for a device whose clock is set to another
country's zone, and ambiguous for the few zones that span countries, where `zone.tab` names one.
A VPN changes nothing, which is right here.

*Rejected: GeoIP on `do-connecting-ip`.* MaxMind's free GeoLite2 needs an account, a license key
in CI and a twice-weekly database refresh; DB-IP's free database needs attribution and a monthly
one; a lookup API sends every visitor's address to a third party. All three process addresses
for a metric nobody needs precisely, and two add a vendor.
*Rejected: `navigator.language`.* Its region tag is the browser's locale, which is `en-US` for most
of the world's English speakers.

### A country per account, overwritten at each sign-in

`app_user.country` (`char(2)`, nullable) holds the latest, and goes with the row when the account
is deleted. A user whose browser never sent one, with JavaScript off or an unknown zone name, is
`null`, which the panel shows as unknown. *Rejected: a row per sign-in.* A history of where each
person has been is more than the question needs, and `audit_event` is for security events.

Privacy: a country code per account, derived from a setting the user's own device reports, with
no address involved. When there is a privacy notice, it names this beside the account data.

### The mapping is a checked-in table, not a dependency

A generated `zone-to-country.json` in `packages/core`, built from a tzdata release's `zone.tab`
with `backward`'s links folded in, beside the script that built it. Zone names change a few
times a year; a name the table lacks maps to `null` rather than failing, so the lookup itself
bounds the input. *Rejected: an npm package for the table.* A dependency for a few hundred lines
of data, which this way carries its own regeneration script.

## PR 1 — capture and show

- A migration adding `app_user.country`.
- `packages/core`: the table, its script, and `countryForTimeZone()`.
- `apps/web`: after sign-in, the `(app)` layout posts the time zone to a small endpoint once per
  session, and the endpoint stores the mapped country. Nothing waits on it.
- `metrics`: a `users_by_country` view and a Grafana panel, following `dashboards.md`.
- The privacy notice, if there is one by then, gains a line.
- Delete this plan.

## Verification

- Signing in from a browser set to a non-US zone shows that country on the account's row and in
  the panel; a made-up zone name leaves `null`.
- Deleting the account deletes the row; the existing deletion tests cover the cascade.
