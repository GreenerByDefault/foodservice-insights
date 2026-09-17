# Email provider recommendation

> **Status:** a proposal for the decision [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Email leaves
> **Open**. A human makes the call; this file exists so they do not have to re-derive it. Once
> decided, § Email records the choice,
> [`transports/provider.ts`](../../packages/email/src/transports/provider.ts) gets a real `send`,
> and this file is deleted.
>
> Provider facts were read from each provider's current docs on 2026-09-16 and move; prices drift
> fastest. Cost figures come from [`scripts/email_costs.py`](../../scripts/email_costs.py), kept so
> the estimate can be re-run as the assumptions change.

## What we ask of a provider

Everything above the transport seam is written and tested, and that narrows the ask to almost
nothing. [`client.ts`](../../packages/email/src/client.ts) defines `EmailTransport` as one method
taking a fully rendered message — from, to, subject, `text` and `html` — and
[`mailpit.ts`](../../packages/email/src/transports/mailpit.ts) is a short worked example of
implementing it. So the provider renders nothing, stores no template, and needs no SDK.

1. **An HTTP JSON API that takes both bodies.** We render our own copy
   (`ARCHITECTURE.md` § Email), so provider-side templating is irrelevant, and `multipart/alternative`
   assembly, encoded-words and header folding stay the provider's problem rather than ours.
2. **SMTP credentials as well as that API.** This is the requirement that is easy to miss. Auth is
   email OTP (`REQUIREMENTS.md` § Authentication mechanism) and Supabase Auth sends those codes
   itself — it speaks SMTP, not our transport. Supabase's built-in mailer is capped at 2 messages
   per hour and disclaims any delivery SLA, so production must point it at custom SMTP. **The
   provider therefore carries our login path, not just our notifications**, and an OTP that does
   not arrive is a user who cannot get in at all.
3. **Idempotency keys**, which § Email names explicitly as part of this evaluation — see
   [§ 3](#3-what-idempotency-actually-buys-us).
4. **Answer or fail inside `SEND_TIMEOUT_MS`** (10s), and absorb a burst of
   `maxNotificationsPerSweep` concurrent sends — 5 today, per
   [`config.ts`](../../apps/worker/src/config.ts). Rate limiting is already a sizing input there:
   `maxReapsPerSweep` exists to stop a recovering fleet firing one failure email per stuck attempt
   at once, for exactly that reason.
5. **A searchable log of what was sent.** Delivery is best effort by design, so the standing
   support question is "I never got it" and the answer has to come from somewhere.
6. **Price and simplicity over time** for a two-person nonprofit team.

Candidates: Resend, Postmark, Amazon SES, and Twilio SendGrid. *Rejected: Mailgun.* No idempotency
support, requested on its own feedback forum for eight years. *Rejected: Brevo.* It runs
transactional mail on infrastructure shared with its marketing product, which puts the sign-in
path behind a reputation other people's campaigns can damage. *Rejected: MailerSend.* Mid-field
deliverability in 2026 inbox tests, and it cut its free tier to 500/month in 2025. *Rejected:
running our own MTA.* Same reasoning that rejected a bare Droplet in
[`hosting-provider.md`](hosting-provider.md) — IP warming, blocklist monitoring and DNS
authentication become ours to operate forever.

## 1. Meeting the requirements

| | Resend | Postmark | Amazon SES | SendGrid |
| --- | --- | --- | --- | --- |
| JSON API taking `text` + `html` | Yes | Yes | Yes | Yes |
| SMTP for Supabase Auth | `smtp.resend.com:587` | `smtp.postmarkapp.com:587` (2525 fallback) | Yes, per region | Yes |
| **Idempotency key** | **Yes** — `Idempotency-Key`, 24h, and `Resend-Idempotency-Key` over SMTP | No | No | No |
| Our 5-send burst | 10 req/s per team, raisable | No documented req/s cap; 10 concurrent SMTP connections | 14/s default in production | Well above |
| Message log and search | 30 days, all plans | 45 days; longer is a paid add-on on Pro or above | **None** — build it from SNS + storage | 3–7 days; 30 needs a paid add-on |
| Bounce and complaint handling | Managed suppression list | Managed suppression list | **Ours to build** — SNS topic, subscriber, storage | Managed suppression list |
| Separate staging sending | Second domain/API key | A second Server, its own token and streams | Second identity or account | Subuser (paid tiers) |
| Sandbox on signup | No | No | **Yes** — 200/day to verified addresses until AWS approves production access | No |

### Deliverability: the part we cannot compensate for

Spam filtering splits into things we control and things the provider controls, and it is worth
being precise about which is which, because the split is unusual in our favour.

**Ours, and already close to ideal.** SPF, DKIM and DMARC on our sending domain; the reputation
of that domain; message content; and who we send to. We mail only people who asked for the exact
thing we are sending — a code they just requested, a report they just uploaded, an invite an admin
just addressed to them. No marketing, no purchased lists, no re-engagement campaigns. We are also
far below the 5,000-a-day threshold at which Gmail, Yahoo and Microsoft's bulk-sender rules bite,
so those obligations do not constrain us.

**Theirs, and not negotiable at our volume.** The sending IP's reputation, who else shares that
IP, and how fast the provider evicts the senders poisoning it. This is the crux: a dedicated IP
needs somewhere between 50,000 and 300,000 messages a month to stay warm, and
[`email_costs.py`](../../scripts/email_costs.py) puts us at 155–2,962. **We will be on shared
pools permanently**, so we are renting someone else's reputation and have no way to build our own.

That inverts the intuition that a small sender can shop on price. A high-volume sender can
out-run a mediocre provider on a dedicated IP; we cannot. Choosing the provider *is* choosing our
IP reputation, and it is the one deliverability lever we will never hold.

Published inbox-placement tests rank them consistently, even where the absolute numbers disagree:

| | EmailTooltester 2026 | A second 2026 seed-list test |
| --- | ---: | ---: |
| Postmark | 93.8% (three rounds 95–97%, one 87%) | 83.3% |
| MailerSend | 86.8% | — |
| SendGrid | 82% | — |
| Amazon SES | — | 77.1% |

Treat the ordering as the signal and the percentages as noise: the two tests disagree by ten
points on Postmark alone, seed-list methodology varies, and much of this genre is affiliate-funded.
Three things survive that discount:

- **Postmark leads every test we found**, and it is the only candidate that keeps transactional
  and broadcast mail on separate infrastructure — so no marketing send, ours or anyone else's in
  the pool, can touch the IP carrying a sign-in code.
- **Resend delivers through Amazon SES**, layering its own suppression lists and pool management
  on AWS's sending path. **No public test measures Resend itself**, which for a 2023 company is
  its own kind of answer; SES's 77.1% is the closest proxy and probably a pessimistic one.
- **SendGrid sits low**, consistent with a very large, very mixed sender base.

One factor specific to us: our users are businesses, so their mail is mostly Microsoft 365 and
Google Workspace rather than consumer Gmail. Microsoft is the harsher filter of the two — it
tightened sharply through 2025, forgives slowly, and blocks without notifying the sender. Tests
that report a blended average across consumer mailboxes therefore understate how much the
provider matters here.

## 2. What it would cost us

Output of `scripts/email_costs.py` on 2026-09-16. Volume figures are guesses until production
exists; the script says which ones and how they combine.

| Scenario | Emails/mo | Resend | Postmark | Amazon SES | SendGrid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Launch: ~10 users, ~100 reports/mo | 155 | $0 | $15 | $0.02 | $19.95 |
| Planned: ~40 users, ~500 reports/mo | 707 | $20 | $15 | $0.07 | $19.95 |
| Planned + staging | 907 | $20 | $15 | $0.09 | $19.95 |
| Growth: ~150 users, ~2,000 reports/mo, + staging | 2,962 | $20 | $15 | $0.30 | $19.95 |

What the table is really saying:

- **Cost is not the deciding factor, and the human should not treat it as one.** The whole spread
  is $20/month at the volumes we plausibly reach this decade — less than one scenario's difference
  in [`hosting-provider.md`](hosting-provider.md). Every candidate is rounding error against two
  salaries.
- **Sign-in codes are a quarter to a third of the volume**, and they exist whether or not anyone
  runs a report. That is the line item most likely to surprise someone who budgeted per report.
- **Resend is free at launch and $20 after, and the cliff is the daily cap, not the monthly one.**
  Its free tier allows 3,000/month but only 100/day; the planned scenario is 707/month and ~106 on
  a peak day. Volume clusters, so the free tier expires on a busy Tuesday rather than at a monthly
  total — `PEAK_DAY_SHARE` in the script is the assumption doing that work.
- **SES is free in the way a pile of lumber is a free house.** $0.30/month at growth volume buys no
  message log, no suppression list and no bounce handling; those become code we write and operate.

## 3. What idempotency actually buys us

§ Result notifications makes the notification sweep deliberately at-least-once: a response lost
after the provider accepted the mail is indistinguishable from a send that never went out, so the
sweep re-sends and the user occasionally gets the same result email twice. An idempotency key
keyed on the `analysis_attempt` id closes that window exactly, because the id is already stable
across all five notification attempts.

The window it closes is real but narrow, and sizing it matters more than the feature does:

- It only opens when a send **already failed** in a specific way — accepted, then the response
  lost. Every ordinary failure is caught by `notification_email_sent_at`.
- The blast radius is a duplicate email, capped at `maxNotificationAttempts` (5). No data is lost
  and nothing is corrupted.
- Resend's 24-hour key retention covers our retry window with room to spare: with
  `notificationRetryBaseMs` at 5 minutes and 5 attempts, the whole sequence spans 75 minutes.

So: Resend is the only candidate that closes it, and it would close it cleanly. But this is the
smaller of the two risks on the table — a duplicate notification annoys a user, while an OTP that
does not arrive locks them out.

*Rejected: approximating idempotency against a provider without it.* Postmark can search sent
messages by metadata, so the sweep could ask "did this attempt's mail already go out?" before
sending. That trades a rare duplicate for an extra API call on every single send, and a new
failure mode when the search itself times out.

## 4. What each would cost us in work

| | Resend | Postmark | Amazon SES | SendGrid |
| --- | --- | --- | --- | --- |
| Write `providerTransport` | One `fetch` | One `fetch` | One `fetch`, SigV4-signed, or the SDK | One `fetch` |
| Before the first production send | Verify domain, DNS | Verify domain, DNS, and a Server per environment | Verify domain, DNS, **request production access**, build bounce/complaint handling | Verify domain, DNS |
| Ongoing | Watch the dashboard | Watch the dashboard | Operate the suppression and logging we built | Watch the dashboard |

SES's SigV4 signing is the only one that does not fit the "a `fetch` with that provider's body
shape" note already written into
[`provider.ts`](../../packages/email/src/transports/provider.ts) — it needs either a signing
implementation or the AWS SDK, which is the first third-party dependency this package would take.

## 5. Reliability in 2026

Resend's public incident history is the most active of the four: a 3.5-hour incident on
February 15 that delayed sending and took the dashboard down via database connection exhaustion,
intermittent SMTP problems in mid-February, and delayed webhook events in August. **SMTP is
specifically the path our sign-in codes take**, which weights those incidents more heavily here
than their duration suggests. Postmark and SES publish quieter records; SendGrid's are quiet for
uptime but its deliverability complaints are the recurring theme instead.

Against that, Postmark's service *quality* is the thing reported to have slipped since
ActiveCampaign acquired it in 2022 — accounts suspended without warning and slower support are
the recurring complaints. That is a real risk for a nonprofit whose sending pattern (long quiet
stretches, then a burst) can look anomalous. It is also the kind of claim that comes mostly from
competitor-adjacent sources, so weigh it accordingly.

## 6. Which one is the boring choice

§ 5 asks whether the service was up this year. This asks a different question — who owns it, what
they want from it, and what they have already done to customers they acquired. At these prices
that question outranks cost.

| | Owner | Age | What that implies |
| --- | --- | --- | --- |
| Amazon SES | AWS | 2011 | The genuinely boring one. AWS does not retire services, prices only fall, and there are no forced migrations |
| SendGrid | Twilio (public) | 2009, acquired 2019 | Institutionally safe; no divestiture signals. But it retired its permanent free plan in 2025, so it does reprice |
| Postmark | ActiveCampaign | 2010, acquired 2022 | **The inferred risk.** ActiveCampaign force-migrated its *own* platform's customers in a 2024 plan overhaul and has raised those prices ~40% since. Postmark's pricing has not moved; the risk is the owner's disposition, not anything yet done to Postmark |
| Resend | Independent, VC-backed | 2023 | $21M raised, Series A Dec 2024, ~77 staff. Needs a Series B or profitability; the usual trajectory is upmarket pricing and thinner free tiers |

**The uncomfortable finding is that Postmark does not score best here.** What made Postmark the
safe, boring pick was Wildbit — bootstrapped, profitable, famously unexcitable. That company sold
in 2022. Its owner has since shown, on its own platform, exactly the behaviour a durability-minded
buyer is trying to avoid, and the support complaints in § 5 read as the same story from the other
end. Postmark feels like the incumbent while carrying more ownership risk than its reputation
suggests — though still less than a Series A company that must, by construction, change something.

The other half of the answer is that **durability matters less here than it usually would**,
because of the seam. A provider that raises prices or degrades does not trap us: the blast radius
is one `fetch`, a DNS record, and a Supabase SMTP field. What does *not* migrate is the message
log — switching costs us the history behind "did this user get their email in March" — and, for
Postmark specifically, the deliverability advantage we would have picked it for.

That last point is worth stating plainly, because it cuts against the recommendation below:

- **Postmark's advantage is the least portable thing on the shortlist.** Its separate transactional
  infrastructure is the reason to choose it, and it exists nowhere else, so leaving costs us the
  benefit entirely.
- **Resend's position is the most portable.** It resells SES, so if it repriced or was acquired,
  moving to SES directly keeps the same delivery path and the same shared IP pools, and we build
  only the tooling we had been renting. The startup is, counter-intuitively, the *cleaner* exit.

*Rejected: choosing SendGrid because it is the institutionally safest.* That is the "nobody was
fired for IBM" reasoning taken literally, and here it selects the weakest product of the four —
worst deliverability, no free tier, no idempotency, shortest log retention. Corporate durability
is not a feature our users experience.

## Recommendation

**Postmark, on the Basic plan, $15/month.** Held as the better of two defensible choices rather
than a clear winner; the case for the other is made below in full, so the decision can go the
other way on the same facts.

The decision is Postmark against Resend. SES is right only for a team that wants to own bounce
handling and message logging, and its missing dashboard hurts most on the auth path, which
bypasses anything we build. SendGrid trails on every axis measured here.

**What separates the two is the shape of the risk, not its size.** Each has one failure mode that
would actually reach a user:

- Postmark's is **front-loaded and account-level**: the adversarial onboarding and suspensions
  reported since the acquisition. If it happens, it most likely happens before launch, where we
  see it and switch at no cost. Its steady state after that is the most predictable on the list —
  fifteen years of one product, transactional mail on its own infrastructure, the quietest 2026
  record.
- Resend's is **ongoing and path-level**: a 3.5-hour sending delay and intermittent SMTP faults
  this year, a funding trajectory that must change something, and no independent deliverability
  data. Each is bounded; together they recur, and SMTP is the path our sign-in codes take.

That asymmetry matters because of how our own code protects each path. The notification sweep
retries through an hour of outage by design (`EMAIL_OUTAGE_TO_SURVIVE_MS` in
[`config.ts`](../../apps/worker/src/config.ts)); a sign-in code is sent once by Supabase and either
lands or does not. **The architecture has already absorbed the risk a flaky API poses to result
emails. It has no defence against a flaky SMTP endpoint on the login path.** Provider SMTP
stability is therefore the property to buy, and it is the one where Postmark's record is clean
and Resend's is not.

What we accept: no idempotency key, so the duplicate-send window stays open — the architecture
already lives with it, and it yields a duplicate email rather than a missing one. The ownership
risk in § 6, which is a disposition rather than an action taken against Postmark, and which at
these prices costs dollars rather than users. And 45 days of history: longer retention is a paid
add-on that needs the Pro plan, worth revisiting only if the support workflow turns out to need it.

**The trigger to revisit:** a forced plan migration, a deliverability regression, or a support
failure during an incident. Any one means the thing we bought is gone; the answer is then Resend,
not a second attempt at Postmark.

**Resend is a legitimate choice, and the honest case for it is this.** It is the only candidate
that does what § Email asked this evaluation to look for, over HTTP and SMTP alike. It is free
until we outgrow a hundred-email day and $20 after. Its exit is the cleanest — it resells SES, so
leaving it keeps our delivery path. And the deliverability evidence for Postmark is moderate:
seed-list tests of marketing-shaped mail, not codes and receipts, from a genre that is largely
affiliate-funded; the structural argument (separate transactional infrastructure) carries more
weight than the percentages do. If the team reads Resend's 2026 incidents as growing pains from a
company whose status page has been clean since February, and weighs the architecture's explicit
ask above a structural deliverability argument, Resend is the right call. Choose it knowing the
login path then depends on the SMTP front end where those incidents clustered.

**Amazon SES** is the right answer only if someone wants to own email infrastructure. At $0.30/month
it is essentially free, and it is what Resend resells; everything it saves in dollars it spends in
the bounce handling, logging and production-access work that the other three include.
**SendGrid** — the provider § Email names as an example — is the weakest of the four here: most
expensive, no free tier since 2025, no idempotency, and the poorest deliverability record.

**This is not a one-way door, and that should lower the stakes.** The entire provider surface is
one file behind `EmailTransport`, every message is rendered by us rather than stored with the
provider, and `EMAIL_TRANSPORT` already selects between implementations. Switching later is a new
`providerTransport`, a DNS change, and a redeploy — days, not a migration.

## After the decision

1. Implement `send` in [`provider.ts`](../../packages/email/src/transports/provider.ts) as a
   `fetch` against the chosen provider, keeping every failure inside `emailRequest` so it arrives
   as an `EmailError`, and honoring `SEND_TIMEOUT_MS`. If the provider supports idempotency keys,
   the transport needs the `analysis_attempt` id to use one — `RenderedEmail` carries `kind` but no
   id today, so that is a small type change, not a free win.
2. Add the provider's credential to `.env.example` and the deploy environment, and extend
   `parseTransportSettings` to require it when `EMAIL_TRANSPORT=provider` — it currently validates
   nothing for that case.
3. Buy or designate the sending domain and publish SPF, DKIM and DMARC for it.
   `EMAIL_FROM_ADDRESS` is `noreply@foodservice-insights.test` everywhere today. Send from a
   subdomain rather than the bare domain — it is free to do now and costly to retrofit, and it
   keeps app mail's reputation separate from whatever GBD staff send from the parent domain.
   Start DMARC at `p=none` with a reporting address and tighten once the reports are clean.
4. Point Supabase Auth at the provider's SMTP credentials, and raise Supabase's own auth email
   rate limit, which defaults to 30/hour once custom SMTP is configured. Set the OTP templates to
   match our copy.
5. Give staging its own sending identity — a separate Postmark Server, Resend domain, or SES
   identity — so a test run can never affect production's sending reputation
   ([`staging-environment.md`](staging-environment.md)).

**Open:** nothing consumes bounce or complaint webhooks, whichever provider wins. A hard-bouncing
address will be suppressed provider-side and our sends will silently succeed forever after. Decide
whether to ingest those events or to accept that the provider's dashboard is the only place a
bounce is visible.

**Open:** § Failure modes asks whether we can alert on Auth's own OTP email, which our
notification metrics do not cover. Every candidate sends webhooks for delivery events; that is the
likely mechanism, and it is worth deciding at the same time as the bounce question above.
