# Email through Postmark

> **Status:** a spec. GBD chose Postmark on 2026-10-14
> ([the evaluation](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/email-provider.md)),
> and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Email records the choice. The transport is
> written; what remains is the account and DNS work in § Before PR 1, then one PR that points
> production at it. That PR deletes this file, and
> [`production-sign-in.md`](production-sign-in.md) takes over.
>
> Vendor facts were read from Postmark's and Supabase's docs on 2026-10-14, and
> greenerbydefault.org's DNS with `dig` the same day.

## Context

Our side of the sending is written and tested.
[`postmark.ts`](../../packages/email/src/transports/postmark.ts) sends through Postmark's HTTP
API when `EMAIL_TRANSPORT=postmark`, and `parseTransportSettings` refuses that without
`POSTMARK_SERVER_TOKEN`, so a deploy missing the token fails at startup. Production does not use
it yet: both app specs in [`.do/`](../../.do) still select
[`provider.ts`](../../packages/email/src/transports/provider.ts), a stub that rejects every
send, so a send fails loudly instead of going nowhere until the domain verifies. Supabase Auth sends
sign-in and email-change codes itself, over SMTP, from the templates in
[`supabase-dev/supabase/templates/`](../../supabase-dev/supabase/templates). Locally both go to
Mailpit.

The goal: every message, ours and Supabase's, comes from `insights@greenerbydefault.org`, a real
Google Workspace mailbox that people read and reply from.

That address lives on GBD's existing domain, whose mail setup this plan must not disturb:

| | Today | This plan |
| --- | --- | --- |
| DNS host | Squarespace | Unchanged. Records are added there |
| MX | Google Workspace | Unchanged |
| SPF (root TXT) | `include:_spf.google.com`, HubSpot's include, `-all` | Unchanged; see § DKIM and a custom Return-Path |
| DKIM | `google._domainkey`, and HubSpot's two CNAMEs | Postmark's selector added beside them |
| DMARC | `v=DMARC1; p=reject;`, with no reporting address | Policy unchanged. Optionally gains `rua` |
| Return-Path | n/a | `pm-bounces` CNAME added |

**`p=reject` is the fact that shapes the rollout.** A receiver that honors DMARC refuses any mail
claiming to be from greenerbydefault.org that is not authenticated as it. Until our DNS records
verify, Postmark signs with its own domain, which does not align. So the records must verify
before the first send to anyone; otherwise a sign-in code bounces rather than landing in spam.

## How it fits together

```text
 Every send is From: Foodservice Insights <insights@greenerbydefault.org>

 web, worker ── HTTP API ─► Postmark, stream `outbound` ─┐  DKIM d=greenerbydefault.org, Postmark's selector
 Supabase Auth ─── SMTP ──► Postmark, stream `auth` ─────┤  envelope pm-bounces.greenerbydefault.org
                                                         ├─► recipient
 staff, in Gmail ─────────► Google Workspace ────────────┘  DKIM d=greenerbydefault.org, selector `google`
                                                            envelope greenerbydefault.org, SPF via Google

 Replies ─► MX, unchanged ─► Google Workspace ─► the insights@ mailbox
 Bounces ─► pm-bounces.greenerbydefault.org ─► Postmark. They never reach Workspace
```

Postmark and Google send as the same address without colliding, because nothing they publish
overlaps. Their DKIM selectors differ, and SPF is checked against the envelope domain (Google's
for staff mail, `pm-bounces` for Postmark's), never against the From address.

## Decisions

### Send from the root domain, as a real mailbox

*Rejected: a sending subdomain such as `mail.greenerbydefault.org`.* The evaluation recommended
one, to keep app mail's reputation apart from GBD's own. But users should be able to reply to the
address they see. Supabase Auth's SMTP settings have no Reply-To, so with a subdomain From, a
reply to a sign-in code would go to an address that only works if the subdomain gets its own MX
into Workspace.

What we accept is that the root domain's reputation is shared with staff mail and with GBD's
HubSpot campaigns, so a campaign that draws complaints can push our codes toward spam. Revisit if
Postmark's `auth` stream shows spam complaints or Blocked bounces.

**insights@ is a Workspace user, not a group or an alias.** Each person who answers it is given
access through Gmail delegation, so they read and reply as insights@ from their own login and
nobody shares a password. *Rejected: a Google Group.* Groups refuse posts from outside the
organization by default and hold suspected spam for moderation, so a user's reply could sit
unseen in a queue. *Rejected: an alias on a staff account.* The address would leave with that
person.

**Addresses.** `EMAIL_FROM_ADDRESS` and `EMAIL_SUPPORT_ADDRESS` are both insights@, so help
requests and replies land in one place. `EMAIL_GBD_ADDRESS` is a different address. The GBD
notices (organization created or deleted, user deleted) are operational rather than support, and
Gmail can file a message that is From and To the same mailbox as sent rather than received.
**Open:** which address. GBD names it.

### DKIM and a custom Return-Path; SPF and MX untouched

- **DKIM provides alignment.** Postmark signs as `d=greenerbydefault.org`, under the selector its
  DNS settings page names.
- **A custom Return-Path, `pm-bounces` → `pm.mtasv.net`, aligns SPF too**, under DMARC's default
  relaxed alignment. That gives two independent passes, so a receiver that breaks one still passes
  DMARC. Bounces go to Postmark, which is where suppression lives.
- **Do not add Postmark to the root SPF record.** SPF is checked against `pm-bounces`, which picks
  up Postmark's own SPF through the CNAME. An `include:` at the root would do nothing for Postmark
  and would use up one of SPF's ten DNS lookups.

Once the domain is verified, Postmark will send from *any* address at greenerbydefault.org, with
valid DKIM. Each credential below can therefore send as anyone@greenerbydefault.org. Keep them only
in production secrets and in Supabase, and rotate them if there's any doubt.

### Two streams: `outbound` for our mail, `auth` for Supabase's

Postmark keeps a separate suppression list for each message stream, and a suppression caused by a
spam complaint can only be lifted by Postmark's support
([Postmark](https://postmarkapp.com/support/article/903-an-address-has-been-marked-as-inactive-how-can-i-reactivate-it)).
With one stream, a user who marked a report email as spam could no longer get sign-in codes, and
would be locked out until support replied. Two streams keep that suppression on the report
emails' stream. They also give the sign-in path its own delivery stats, which is what any future
OTP alert would read.

The setup is one Server, "Foodservice Insights", holding the default transactional stream
`outbound` and a second transactional stream, `auth`:

- **Supabase gets an SMTP token generated on `auth`.** That routes its mail to `auth` without the
  `X-PM-Message-Stream` header GoTrue cannot set, and the token can do nothing except send SMTP on
  that stream.
- **Web and worker get the Server API token**, and name `outbound` in each request.
- **Invites stay on `outbound`**, even though they lead to sign-in. Because an admin typed the
  address, they are the emails most likely to bounce.

The Basic plan allows 15 streams.

### The transport

`postmark.ts`'s header carries the per-request choices and their reasons: every send on
`outbound`, `Tag` set to the email's `kind`, open and link tracking off explicitly, no
idempotency key. The one that shapes how failures look in production: **an error carries
Postmark's `ErrorCode` but never its `Message`, and is labelled with the kind rather than the
recipient**, because the message for a suppressed recipient (422, `ErrorCode` 406) names the
address. So a 406 in our logs says *that* an address is suppressed, and Postmark's activity says
which.

### Supabase Auth sends over SMTP

*Rejected: Supabase's Send Email Hook*, which would hand codes to an endpoint of ours to send
through `@gbd/email`. That is a public endpoint on the login path for us to write, secure and
keep running, and all it would add is visibility that the `auth` stream already gives.

**The Auth email rate limit goes from 30 to 100 an hour.** Supabase sets 30 once custom SMTP is
on, and the limit is project-wide, so reaching it stops every sign-in for the rest of the hour.
One onboarding session for a 40-person customer could reach 30. No setting that leaves sign-in
usable would protect Postmark's bounce rate; a CAPTCHA would, and
[`production-sign-in.md`](production-sign-in.md) adds one at the first sign of abuse.

### Not yet: bounce and complaint webhooks

This answers the evaluation's two **Open:** questions: whether to ingest bounces, and whether to
alert on Auth's OTP email. Without webhooks, each failure surfaces like this:

| Failure | How we see it |
| --- | --- |
| Postmark down, or our account suspended | Every send fails. Our sends log an `EmailError`, the sign-in form shows an error, and Postmark emails the account owner about a suspension |
| An address suppressed | Our sends fail with 406 in our logs. Supabase's codes to it show in the `auth` stream's Suppressions tab |
| A receiver blocks us | A Blocked or DMARCPolicy bounce in Postmark's activity |
| A receiver files us as spam | Nothing. Webhooks cannot see it either |

Webhooks would only report the middle two rows sooner, and at roughly 700 messages a month
(the evaluation's estimate) those events are individual or rare. **Trigger:** build it the first
time the `auth` stream shows a Blocked bounce. The likely shape is Postmark's Bounce webhook
posting to a Better Stack log source, which needs no endpoint of ours; first check that Better
Stack's ingest accepts Postmark's payload as is. *Rejected: Grafana polling Postmark's stats
API.* Postmark has no read-only token, so Grafana would hold one that can send as anyone at
greenerbydefault.org.

## Before PR 1: accounts and DNS

Do these steps in order: because of `p=reject`, the DNS must verify before the first send.

1. **Workspace (a GBD admin).** Create insights@ as a user. Turn on Mail delegation in the Admin
   console if it is off, then delegate the mailbox to whoever will answer it.
2. **Postmark account.**
   - Have a GBD staff login own the account, and add Eric as a second user;
     `hosting-provider.md` already ruled out a shared login.
   - Create the Server and the `auth` stream. Turn open and link tracking off on both streams;
     the stream settings are what govern Supabase's mail.
   - **Request account approval now.** Until Postmark approves the account, it delivers only to
     domains verified on the account. That is fine for testing on greenerbydefault.org addresses,
     and a blocker for launch. Describe the use as transactional only: sign-in codes, report
     results, and invites, sent to people who signed up or were invited, with no marketing.
3. **Add greenerbydefault.org** under Postmark's Sender Signatures → Domains. Postmark lists two
   records.
4. **Squarespace DNS (whoever holds GBD's domain login).** Add exactly those two records as Custom
   Records:
   - a TXT record at the DKIM host Postmark shows (it ends in `._domainkey`), with the value copied
     whole;
   - a CNAME record, `pm-bounces` → `pm.mtasv.net`.

   Squarespace appends the domain to each host, so enter the host without `.greenerbydefault.org`.
   Change nothing else: MX, SPF, DMARC, and the Google and HubSpot DKIM records stay as they are.
5. **Confirm, then verify.** `dig +short TXT <host>.greenerbydefault.org` should return Postmark's
   value, and `dig +short CNAME pm-bounces.greenerbydefault.org` should return `pm.mtasv.net.`.
   Then press Verify on both records in Postmark.
6. **Optional: DMARC reports.** greenerbydefault.org has `p=reject` but no `rua`, so nobody sees
   what receivers reject on its behalf. Postmark's free DMARC digest supplies a reporting address;
   **edit** the existing `_dmarc` TXT record to `v=DMARC1; p=reject; rua=mailto:<that address>`.
   Never add a second `_dmarc` record: two DMARC records are invalid, receivers then ignore both,
   and the domain loses its spoofing protection. The record covers all of GBD's mail, so this is
   GBD's call; the plan works without it.
7. **Make a first send** with the Server API token, to a greenerbydefault.org address:

   ```sh
   curl https://api.postmarkapp.com/email \
     -H 'Accept: application/json' -H 'Content-Type: application/json' \
     -H "X-Postmark-Server-Token: $POSTMARK_SERVER_TOKEN" \
     -d '{"From": "Foodservice Insights <insights@greenerbydefault.org>",
          "To": "<you>@greenerbydefault.org", "Subject": "Postmark test",
          "TextBody": "Test", "MessageStream": "outbound"}'
   ```

   In Gmail, "Show original" must show SPF, DKIM and DMARC all as **PASS**, with DKIM for
   `greenerbydefault.org` and SPF for `pm-bounces.greenerbydefault.org`. Gmail must not show "via"
   beside the sender. A reply to the message should land in insights@.

### Supabase Auth's settings

After step 7, in the production project's dashboard:

- **SMTP:** host `smtp.postmarkapp.com`, port 587. The username and password are the access key
  and secret key of the `auth` stream's SMTP token. The sender is `insights@greenerbydefault.org`,
  with the name `Foodservice Insights`.
- **Templates**, pasted from `supabase-dev/supabase/templates/`, with the subjects from
  [`config.toml`](../../supabase-dev/supabase/config.toml):
  - "Magic link" and "Confirm signup" both get `sign-in-code.html`. GoTrue's default templates send
    a link, and new users get "Confirm signup" once `production-sign-in.md` turns on email
    confirmation.
  - "Change email address" gets `email-change.html`.
- **Secure email change off**, matching `double_confirm_changes = false` in both local
  `config.toml`s: `/account` asks for one code, sent to the new address.
- **Rate limit for sending emails:** 100 an hour.
- **Check it.** Send a code to a greenerbydefault.org address, from the dashboard's Users page or
  with `POST /auth/v1/otp` and the publishable key. Repeat step 7's header checks, and confirm the
  message shows up in Postmark under `auth`.

## PR 1 — production sends through Postmark

This comes after § Before PR 1. Store `POSTMARK_SERVER_TOKEN` as a secret in the `production`
GitHub Environment before merging: an unset `${NAME}` fails the deploy
([`.do/README.md`](../../.do/README.md)).

- **Both app specs, `.do/web.yaml` and `.do/worker.yaml`:**
  - `EMAIL_TRANSPORT=postmark`, replacing `provider`;
  - `POSTMARK_SERVER_TOKEN` as a `type: SECRET` entry with value `${POSTMARK_SERVER_TOKEN}`;
  - `EMAIL_GBD_ADDRESS` set to the address GBD names, replacing the insights@ stand-in.

  `EMAIL_FROM_ADDRESS` and `EMAIL_SUPPORT_ADDRESS` are already insights@. The worker needs the
  token too, because `@gbd/email/env` builds the same transport.
- **Delete the stub:** `provider.ts`, its test, its export, its `TransportName` member and the
  `provider` cases in `transports/index.ts` and `index.test.ts`, and the `.do/README.md` bullet
  that explains it.
- **Both local `config.toml`s gain `[auth.email.template.confirmation]` → `sign-in-code.html`.** It
  goes unused while local confirmation is off, but this way the repo names every template
  production uses. Beside the template stanzas, add one comment: production's copies are pasted
  into the Supabase dashboard, so a change here must be pasted there too.
- **`ARCHITECTURE.md` § Email, a few lines:**
  - our mail goes on `outbound` and Supabase's on `auth`, and why;
  - "I never got it" is answered from Postmark's activity for that stream;
  - a spam complaint suppresses an address until Postmark's support lifts it.
- **Delete this plan.**

## Verification

- Step 7's header checks pass for each path: an app email (send an invite) and a sign-in code.
- A reply to each lands in insights@. A delegate's message sent as insights@ reaches an outside
  address and passes DMARC through Google's own signing, which proves Workspace still uses the
  address fully.
- After approval, an outside Gmail address and an Outlook.com address each receive both kinds of
  email in the inbox, not in spam.
- Postmark's activity shows app mail on `outbound`, tagged by kind, and codes on `auth`.
- If step 6 was done, the first weekly digest shows Postmark, Google and HubSpot all passing.
