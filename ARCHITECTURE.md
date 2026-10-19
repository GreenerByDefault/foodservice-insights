# Architecture

How the system fits together, and why. For *what* the product must do, see
[`REQUIREMENTS.md`](REQUIREMENTS.md). For how to run and build it, see
[`README.md`](README.md).

**tl;dr:** A SvelteKit web app (frontend and backend together) accepts a CSV upload, writes it to
a blob store, and enqueues an analysis attempt in Postgres. A long-running worker claims attempts
off that queue and spawns Python child processes that run the `gbd_foodservice_insights` AI library. The
worker writes results back to the database and blob store; the web app learns of completion by
polling the database. Postgres, auth, and the blob store are all Supabase.

Sections marked *Rejected:* record alternatives we considered and turned down. They are here to
keep settled decisions settled — read them before proposing a change.

## Stack

| Concern | Choice |
| --- | --- |
| Database | Postgres via Supabase |
| Auth | Supabase Auth, email OTP |
| Blob store | Supabase Storage, via its S3 API |
| Web frontend + backend | SvelteKit |
| Database access | Kysely, with Kanel-generated types |
| Migrations | Kysely |
| Styling | Tailwind and shadcn-svelte |
| Worker parent process | TypeScript on Node.js |
| Worker child process | Python, running `gbd_foodservice_insights` |
| Queue | Postgres |
| Unit and component tests | vitest |
| End-to-end tests | Playwright |
| Edge / DDoS | The host's own edge; nothing of ours — [§ Hosting](#hosting) |
| Registry | GHCR, `ghcr.io/greenerbydefault/foodservice-insights/{web,worker}`, tagged by commit SHA |
| Hosting | DigitalOcean App Platform — [§ Hosting](#hosting) |
| Email | Postmark, using HTTP and generated emails — [§ Email](#email) |
| Logs and uptime monitoring | Better Stack ([why](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/observability-vendors.md#22-where-they-go)) |
| Dashboards and data alerts | Grafana Cloud ([why](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/observability-vendors.md#31-why-grafana-cloud)) |

## Components

| Component | Language | Owns |
| --- | --- | --- |
| `apps/web` | TypeScript | Frontend, backend routes, upload validation, file links, invite and GBD-notice email |
| Worker parent | TypeScript | Queue claiming, child process lifecycle, DB and blob store writes, email |
| `packages/*` | TypeScript | Shared database, storage, email, and domain code |
| `python/worker_child` | Python | One analysis run, via `gbd_foodservice_insights` |
| `python/insights` | Python | The AI analysis library |
| `python/lab` | Python | Data-science experiments. Ships nothing |

Only the web app and the worker parent touch the database and blob store. The child process
touches neither; it reads and writes a run directory the parent sets up for it.

## Supabase: database, auth, and blob store

Supabase provides the Postgres database, the blob store (Supabase Storage), and auth (Supabase
Auth) as one hosted platform.

**We do not use client-side database access or Row Level Security (RLS).** All database access
goes through the server, the traditional architecture. RLS is easy to get wrong, substantially
increases the app's complexity and security risk, and increases vendor lock-in. The one exception
is Supabase Auth, which the client talks to directly.

**We use Supabase Storage through its S3 API**, not the Supabase JavaScript SDK, to reduce vendor
lock-in. We can switch blob store providers if cost becomes an issue.

**Every process connects to the database directly**, not through Supabase's pooler, over TLS
verified against the committed [`supabase-ca.crt`](supabase-ca.crt). The hosted project has the
IPv4 add-on, without which the direct host is unreachable from IPv4-only clients like GitHub's
runners. Every client's share of `max_connections`, Supabase's own included, is budgeted in
[`budget.ts`](packages/db/src/budget.ts), which owns the reasoning and the numbers.

## Web app

SvelteKit covers both the frontend and the backend, using its default rendering strategy:
server-side rendering (SSR) for the first request, then client-side navigation (CSR) after
hydration. Server-only code (`hooks.server.ts`, `+layout.server.ts`, `+page.server.ts`) runs on
every navigation regardless of whether the client re-renders the page.

**Database access, in both the web app and the worker, uses [Kysely](https://kysely.dev)**, a
type-safe SQL builder: we write SQL directly in TypeScript. This gives predictable query
performance, unlike an ORM, while keeping the ergonomics an ORM provides through TypeScript
integration. [Kanel](https://kristiandupont.github.io/kanel/) generates the types from the live
database. Kysely also handles migrations.

How routes are structured within `apps/web` — including why they call `+server.ts` handlers with
plain `fetch()` rather than form actions or remote functions — is in
[`apps/web/README.md`](apps/web/README.md#routes).

## Auth

Auth is entirely within `apps/web` — Supabase Auth on the client, a `handle()` hook that resolves
the JWT into `locals` on the server. See [`apps/web/README.md`](apps/web/README.md#auth) for the
design.

**A Content Security Policy is what stands between an XSS and a stolen session**, because the
session cookie cannot be `HttpOnly`. See `kit.csp` in `apps/web/vite.config.ts` and
`apps/web/src/lib/server/security-headers.ts`. Browsers report violations to `/csp-report`, which
logs each one at `warn` as `CSP violation`.

**Open:** validating sessions with `getClaims()` instead of `getUser()`, once the hosted project is
confirmed on asymmetric signing keys. It checks the JWT locally, removing the round trip to Supabase
Auth that every request — the poll endpoints included — pays today, at the cost of no longer
noticing a deleted user before their token expires.

## Client ↔ server

The client polls the server on the interval set by `BASE_POLL_INTERVAL_MS` in
[`apps/web/src/lib/polling/schedule.ts`](apps/web/src/lib/polling/schedule.ts).

- *Rejected: WebSockets or Server-Sent Events.* Both are dramatically more complex, and both
  require holding a connection open for the entire processing lifecycle. Keeping connections
  minimal and stateless simplifies performance and leaves the door open to horizontally scaling
  the web server.

**A failed poll is not a failed analysis.** The two are independent: a poll that does not reach
the server says nothing about the attempt, so the client keeps the last known state on screen,
backs off, and carries on polling. Only a terminal `analysis_attempt.status` may offer a retry,
because a retry costs a worker run.

- *Rejected: retrying an upload automatically.* A request that may already have enqueued an
  attempt cannot be retried safely, and a lost response is exactly the case where we cannot tell
  whether it did.

## Server ↔ worker

The server enqueues new analysis attempts. **Workers pull from the queue; the server never talks
to a worker.**

The worker writes results — including failures — directly to the database and blob store. It does
not talk back to the server. The server discovers that a worker has finished by reading the
database.

## Worker queue

The queue is Postgres. A worker claims the oldest pending attempt with a single guarded
`UPDATE ... FOR UPDATE SKIP LOCKED`, giving the semantics we need: roughly FIFO,
concurrency-safe, and atomic. The statement lives in
[`claimNextAttempt`](apps/worker/src/attempt/queue.ts), which this section is the contract for.

- *Rejected: a dedicated queue service such as Celery or Redis.* Postgres keeps the
  infrastructure smaller by having fewer components. The risk is that Postgres is not built for
  high throughput (thousands of attempts per second); if throughput ever grows that far, swapping
  in a real queue is straightforward.
- *Rejected: automatic requeuing.* Once a worker claims an attempt it leaves the queue. If the
  attempt fails for any reason, no other worker retries it — **retrying is a user-initiated
  action.** This is a simpler architecture.
- *Rejected: `LISTEN`/`NOTIFY` pub-sub.* Workers poll every 1–2 seconds over a long-lived pooled
  connection, which is simpler.

## Worker

> The detail in this section moves to `apps/worker/README.md` when that package lands. The seams
> — the queue contract above, and the parent ↔ child run directory — stay here.

`gbd_foodservice_insights` is heavily IO-bound with many API calls: light CPU, moderate memory, no GPU.

The worker is a long-running process in a Docker container. It uses no web framework — it does not
serve requests.

The worker has a **parent process** that spawns up to 3 **child processes** running
`gbd_foodservice_insights`. Each child is a separate Python process for isolation (spawn, don't fork).
**Only the parent interacts with the database and blob store**, which simplifies the child and
shrinks the security blast radius.

Parent lifecycle:

1. Pull an analysis attempt from the queue, if current attempts < 3.
2. Fetch the input file from the blob store.
3. Spawn a child process to run `gbd_foodservice_insights`, setting up a folder with the required inputs.
  - The inputs include the human-verified product categorizations, read fresh on every claim; [`attempt/lifecycle.ts`](apps/worker/src/attempt/lifecycle.ts) says why.
4. The child runs, writes its results into that folder, and exits.
  - Exit 0 plus a result file the parent can parse is success; exit 1 means the child wrote a failure instead; any other exit means it reached no verdict at all.
  - Throughout, the child keeps `telemetry.json` current: its LLM usage and each finished stage's counts and time.
5. Upload the result files to the blob store and save metadata to the database.
  - After a recorded success, suggest the products the child's LLM categorized to the cache, unverified. Like the telemetry, it never changes the verdict.
  - Then, whatever the ending and whoever now owns the attempt, record the telemetry. It never changes the verdict.

Whenever a child fails in any way — including being killed by its parent — the parent marks the
analysis attempt failed. Either way, the parent does not send the email itself — a separate,
derived sweep does, in [`sweeps/notifications.ts`](apps/worker/src/sweeps/notifications.ts); see
§ Email below. A `canceled` row gets no email at all.

Refer to [`contract/`](contract/) for the worker ↔ child contract.

### Progress, leases, and reaping

Catching a hung or crashed analysis means answering two different questions — is the *child*
still making progress, and does the *parent* still get to act on that — and each has to keep
working when the other's machinery is down. That split is **two independent axes**, and mixing
them forfeits what each is for:

| | Axis A — child liveness | Axis B — supervisor authority |
| --- | --- | --- |
| Medium | the filesystem | Postgres |
| Signal | `progress.json` `sequence` → parent's `lastProgressAt` | the guarded `UPDATE` |
| Clock | the parent's, only ever as a difference | the database's, on both write and read |
| Answers | should I kill this child? | may I still write this attempt's verdict, and is anyone still watching it? |
| Survives a DB outage | **yes, by design** | no |
| Survives losing the container | no | **yes, that is its whole job** |

Because Axis B reads and writes the *database's* `now()`, cross-worker liveness never depends on
worker clocks agreeing. Because Axis A only ever subtracts the *parent's* clock, it keeps working
through a total database outage. **Never write the child's progress timestamp into the
database** — see *Rejected* below for why that specific mistake is not just untidy but unsafe.

The one rule that resolves the two axes into one design:

> **A worker renews the lease on an attempt if and only if it has just checked that attempt's
> child and will still reach a verdict for it.**

Child progress is an *input* to the renewal decision, never the value written. "Has someone taken
this attempt?" is the renewal's *answer*. "Tell other parents I am alive" is its *effect*.

That rule has a corollary: a parent that cannot evaluate its child's health must **stop
renewing**, so the reaper converges the attempt. This is the same shape as "only a zero-row update
means lost" below: *the write fails ⇒ still run the checks; the checks cannot be evaluated ⇒ skip the
write.* The two rules this adds on top — no check, no renewal; and fencing once a lease has expired — are
decided in [`apps/worker/src/failures.ts`](apps/worker/src/failures.ts), which names them.

Four layered defenses, because a hung analysis has to be caught even if the process that should
notice it is itself hung:

1. **The child reports progress** by updating a file every time it makes progress, such as
   finishing an API call. The parent checks that file roughly every 30 seconds. If the child has
   not progressed in `killAfterNoProgressMs`, the parent kills it as hung. The threshold must exceed
   the longest valid API call including backoff — see [`config.ts`](apps/worker/src/config.ts).
2. **The parent hard-kills** a child after `killAfterTotalRuntimeMs` no matter what, as a safety net
   for hung attempts — see [`config.ts`](apps/worker/src/config.ts).
3. **A claim held too long is reaped, regardless of what its lease says.** `claimedCeilingMs` catches a
   parent that keeps renewing a lease forever but never actually finishes the attempt — a failure
   the other two defenses cannot, since both watch the *child*, and this parent's child may look
   perfectly healthy. It is the second, independent predicate of the same sweep as defense 4, since
   the parent this catches is by definition not going to catch itself. See
   [`config.ts`](apps/worker/src/config.ts).
4. **Other workers reap**, in [`converge.ts`](apps/worker/src/sweeps/converge.ts). The reaper exists for the
   *row*, not the processes: the parent is PID 1 in its container, so killing it tears down the PID
   namespace and takes every child with it, and the PaaS restarts the container — there is no
   orphan class of process to worry about. What can happen is a container dying (e.g. OOM) and
   leaving its claimed attempts stuck `processing`, with nobody left to reach a verdict and nothing
   else to ever converge them. So, every worker proactively looks for `processing` attempts whose
   lease has expired and marks them `failed('abandoned')` — see
   [`converge.ts`](apps/worker/src/sweeps/converge.ts). The notification sweep sends the email, on its
   own schedule, once the row is terminal.

Reaping introduces a race: another parent can kill an attempt while the original parent, being
hung, does not realize it. **All database updates to an analysis attempt must be written to
tolerate this** — see the terminal-state and status invariants in
[`packages/db/README.md`](packages/db/README.md#the-analysis-attempt-state-machine).

When the parent's own database calls fail, **only a zero-row guarded update means we lost the
attempt**; an error means only that we still do not know.

A *thrown* lease-renewal error skips that write, but the local no-progress and hard-ceiling
checks still run — they read the clock and the progress file, not the database. A progress read
that itself throws is the mirror image: it skips the renewal, and it skips the no-progress check
it could not evaluate. But the two rules that read nothing but the clock — the hard ceiling and
fencing — keep firing regardless, so an unreadable `progress.json` can never buy a child unbounded
runtime.

A parent that gives up on recording a verdict stops renewing the lease first, so reaping can
still converge the attempt. Reasoning in
[`apps/worker/src/failures.ts`](apps/worker/src/failures.ts).

*Rejected: writing the child's progress timestamp into the database.* It collapses the two axes
onto one medium: a parent whose database is down stops being able to answer "should I kill this
child?", and a parent whose clock is skewed poisons every other worker's liveness judgement.

*Rejected: excluding the reaper's own `worker_id` from the sweep.* A live parent already kills its
own children locally, so the only case where the reap's own filter would matter is a parent that is
alive but no longer directing — exactly when the reap should fire. Reaping one of our own costs
nothing: the next lease renewal returns "lost" and the direct loop kills the child. See
[`converge.ts`](apps/worker/src/sweeps/converge.ts).

### Canceling

The web server never writes `analysis_attempt.status`. Canceling writes `cancel_requested_at` on a
non-terminal attempt, and a worker converges it to `canceled` — the owning parent on its next lease
renewal, or the queue's cancel sweep if nobody has claimed it.

- **Deleting a report also writes `cancel_requested_at`**, in the same transaction as
  `report.deleted_at`. Soft-deleting on its own would not stop anything, because no worker reads
  `deleted_at` — `cancel_requested_at` is what ends an analysis, whichever action the user took.
- **A cancel request does not guarantee a `canceled` row.** The owning parent enforces a cancel by
  killing its child, and only notices the request on its next lease renewal. A child that finishes
  before that tick records `succeeded` or `failed`, and that verdict stands — see `markIfStillOwned`
  in [`queue.ts`](apps/worker/src/attempt/queue.ts). So a terminal attempt can carry a
  `cancel_requested_at`, and a reader has to trust `status` over the request.
- **No email is ever sent for a canceled attempt.**

### Concurrency and scaling

Three independent levers:

| Lever | Effect |
| --- | --- |
| `ThreadPoolExecutor` inside `gbd_foodservice_insights` (`LLM_CONCURRENCY` in [`categorization/llm.py`](python/insights/gbd_foodservice_insights/categorization/llm.py)) | Speeds up an *individual* attempt |
| More child processes per worker (vertical) | More concurrent attempts; limited by CPU and memory contention |
| More workers (horizontal) | More concurrent attempts |

Note that `asyncio` is *not* the right tool inside `gbd_foodservice_insights`; use
`ThreadPoolExecutor`.

Every lever multiplies API load: `max concurrent API calls = workers × child processes × threads`.
Watch upstream rate limits when tuning any of them. More workers, or more attempts per worker, also
spend database connections from that same budget (see [Supabase](#supabase-database-auth-and-blob-store)).

We will probably start with 2 workers, handling 4–6 concurrent attempts depending on whether each
worker runs 2 or 3.

## Deployments

Web and worker are separate services, each shipped as a Docker image and deployed independently.

### Images

Web and worker each build from [`apps/web/Dockerfile`](apps/web/Dockerfile) and
[`apps/worker/Dockerfile`](apps/worker/Dockerfile) — Docker rather than the hosting platform's
build packs, because our deployments are complex enough to need it (the worker alone is
polyglot). **Both build on Red Hat's UBI minimal images**, not Debian/Alpine bases like
`node:*-slim`: UBI is free to redistribute without a Red Hat subscription, gets CVE patches on a
predictable cadence, and the `-minimal` variant uses `microdnf` to stay small while still being a
full RPM-based system if we ever need a package the slim bases lack.

[`workflows/deploy.yml`](.github/workflows/deploy.yml) builds both images on every push to `main`
and pushes each to the GitHub Container Registry, tagged with the commit SHA — one pair of images per
commit, whether or not that commit ever deploys. **A deploy is a promotion of an existing image,
never a rebuild:** it resolves the commit SHA it's deploying to that image's digest and hands the
digest to the hosting provider.

**An image carries no environment's configuration.** A build-time `PUBLIC_*` or a
`static: true` variable would bake one in, and promoting that image — forward or back — would
start shipping the wrong config with it. Read configuration at runtime instead.

### Web deploys on every push

Web deploys automatically on every push to `main`, database migrations included, because it's the side
that owns the schema. **`deploy.yml` runs the database migrations itself, before it deploys to the
hosting provider.** There is no way to unapply a database migration; a bad one is fixed forward.
So every migration runs against the code already deployed, and
[`packages/db/README.md`](packages/db/README.md#writing-a-migration) says what that rules out.

### Worker deploys only on demand

Deploying the worker naively kills every in-flight analysis attempt, since the hosting platform
kills the old container outright. Two mitigations, both required:

- **The worker deploys independently of web, and only when someone dispatches it** — never on
  push. One consequence follows from that asymmetry: the deployed worker is always the side running
  behind schema and web app, never ahead, so the web ↔ worker and app ↔ schema contracts must stay
  backwards compatible for as long as an old worker might still be running. `deploy.yml` deploys
  the worker at the commit the web runs, so only a rollback from the host's dashboard can leave the
  worker ahead.
- **The worker drains rather than dying.** The parent distinguishes `SIGTERM` from `SIGKILL` and
  gives an in-flight attempt `drainGraceMs` to finish before forcing it — see
  [`config.ts`](apps/worker/src/config.ts) for the grace values and why they're sized the way they
  are. An analysis attempt still running when the grace expires gets `failed('shut_down')`. The
  drain is derived from the platform's own shutdown grace, which
  [`.do/worker.yaml`](.do/worker.yaml) sets.

### Bad deploys are fixed forward

**`deploy.yml` never rolls back: a bad deploy is undone by reverting its PR, which deploys like
any other change.** That is one path everyone, agents included, already knows, rather than a
second one used only under pressure. It also keeps migrations simple: every deploy migrates
forward, so nothing has to decide when to skip one. CI refuses a revert that deletes a migration;
undo one with a new migration instead.

When an outage can't wait for CI, the hosting provider's own rollback redeploys an earlier image.
Land the revert before the next worker deploy, which would otherwise run ahead of the web.

### Hosting

Web and worker run on **DigitalOcean App Platform**. It was the only candidate that documented
everything this pipeline depends on: deploying a digest-pinned GHCR image from CI with a real exit
code, a shutdown grace long enough to drain the worker, and CPU and memory alerts
([why](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/hosting-provider.md)).
We explicitly do not care about autoscaling. Each service is its own app, configured entirely by
its spec in [`.do/`](.do/README.md).

**No edge of our own sits in front of App Platform.** Its edge is Cloudflare's network, so
volumetric DDoS protection comes with the host. It passes none of Cloudflare's headers to the app,
so nothing here learns a visitor's country from the network. *Rejected: a Cloudflare zone of our
own.* The free plan runs DNS for a whole zone, so it meant moving GBD's website DNS to Cloudflare
or registering a second domain, plus a Worker to rewrite `Host` the way App Platform's proxy
guidance requires, to buy a WAF, geo-restriction and country counts that are not worth a vendor
([why](https://github.com/GreenerByDefault/foodservice-insights/blob/6af236b7c5dcdf58bcf4d05168aeb5ae883a1772/.claude/plans/cloudflare-and-domain.md)).

*Rejected: Railway and Render.* Railway documents neither a digest deploy nor a long shutdown
grace; Render caps its grace at five minutes and has no native CPU or memory alerts.

## Blob store

Refer to [`packages/storage/README.md`](packages/storage/README.md) for the private bucket's layout and code.

## Email

We send email as HTTP requests to a provider, using emails generated in
[`packages/email`](packages/email) rather than a template stored with the provider. That keeps
templates in version control and swappable across local mail catchers and providers alike.

Locally, mail goes to [Mailpit](https://mailpit.axllent.org), a fake SMTP server with a web
inbox, so nothing leaves the machine. `packages/email`'s own tests and e2e tests read that inbox
for real.
Every other test fakes the transport with an in-memory `recordingEmailer()`, asserting only that
the right email was asked for.

The provider is **Postmark**, chosen above all for deliverability
([why](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/email-provider.md)).

The `packages/email` code does not retry failures. Instead, callers must decide how to handle
failure.

Sign-in codes and email-change confirmations go through Supabase Auth, not us.

### Result notifications

Sending the result email is not part of settling an attempt. A separate, derived sweep,
[`sweeps/notifications.ts`](apps/worker/src/sweeps/notifications.ts), computes which rows are
"due" straight from `analysis_attempt` — terminal, not canceled, unsent, still has a requester,
attempts remaining — rather than pushing a job onto a queue when an attempt finishes.

A sweep claims due rows with a short-lived claim, which is what gives mutual exclusion between
workers, then sends. `notification_attempts`, incremented by the claim, both caps the spend and
turns the claim's own expiry into the backoff: bounded exponential, doubling from
`notificationRetryBaseMs` each try. Its total window, and its floor against `@gbd/email`'s
`SEND_TIMEOUT_MS`, are both checked in [`config.ts`](apps/worker/src/config.ts).

This is deliberately at-least-once, not at-most-once: a response lost after the provider accepted
the email looks identical to a send that never went out, so an occasional duplicate is the
tradeoff for never silently dropping one.

## File links

Per [`REQUIREMENTS.md`](REQUIREMENTS.md), file links are public and non-expiring: anyone with the link can access the
file. But a deleted report's links must stop working, while the file itself stays in the blob
store for debugging. Supabase Storage buckets are public or private as a whole, so a direct link
into a public bucket cannot express this.

Instead, **file links go through a lightweight public API on the web server.** The server checks
whether the file is still accessible, and if so issues a temporary signed URL from the blob store.
The bucket stays private; our stable links are the only way in.

Routing downloads through our server also means we can add server-side download metrics later.

## Input file upload and validation

**The web server accepts only CSV**; the client converts XLSX to CSV before uploading with
`read-excel-file`, taking care with Excel dates.
[`apps/web/src/lib/reports/excel/`](apps/web/src/lib/reports/excel/) owns that conversion, which
tab of a workbook is read, and the reasoning behind both.

**The original workbook travels as a second field and is stored without ever being opened** —
sized, sniffed for `PK`, hashed, stored. Decompressing or parsing it server-side would move every
zip- and XML-bomb risk out of the uploader's own tab and onto us, so the guard against those runs
in the browser, in `excel/zip.ts`, against a cap in
[`apps/web/src/lib/reports/limits.ts`](apps/web/src/lib/reports/limits.ts). The upload's download
link then hands back the file the user actually chose rather than a CSV they never saw.

**A workbook the browser refuses is never sent**, so no workbook-specific rejection reaches
`rejected_upload` and that table needs no new reason value for one.

**The file is sent directly to the web server**, not through a presigned upload URL. At a 10MB
cap the performance is fine, the server has to download the file for validation anyway, and it
avoids the risk of a presigned URL accepting arbitrary bytes.

**The web server fully validates before uploading to the blob store**, including security scans,
so the worker does not need to re-validate exhaustively.
[`apps/web/src/lib/reports/submission.ts`](apps/web/src/lib/reports/submission.ts) decides what is
accepted, and is imported by the browser as well, so the two cannot disagree.

`gbd_foodservice_insights` is already written to reduce prompt injection risk — for example, all output
belongs to a fixed set of values.

## Secrets management

Secrets load as environment variables. Locally they all live in one gitignored file, `.env`,
templated by `.env.example`. `.env.test` is committed because every value in it is safe in version control and needed for tests.

GitHub Actions holds every production secret, for the migrate step in
[`deploy.yml`](.github/workflows/deploy.yml) and for the running apps, which receive theirs at
deploy ([`.do/README.md`](.do/README.md)) — only in the `production` Environment, which only
`main` can deploy from, never as repo secrets.

**Server config is read at runtime, not inlined at build time** — every variable in
`apps/web/src/env.ts` is dynamic, never `static: true`. One build artifact therefore runs against
any environment, and rotating a credential does not require a rebuild. The cost is that no server
module may read config at the module-level while being imported.

**Open:** no rotation process exists yet for suspected leaks.

Extra care with production access is warranted because AI agents operate in this repo.

## Observability

### Alerts

Each alert is evaluated by the system that already holds its data, so each layer keeps working
when another's inputs fail.

| Layer | Evaluated by | Sees | Rules live in |
| --- | --- | --- | --- |
| Host | DigitalOcean | Each container's resources and restarts, and failed deploys | Each app's spec in [`.do/`](.do/README.md) |
| Data | Grafana Cloud | The queue and notifications, as the database's rows record them | **Open:** not built yet |
| Outside | Better Stack | What a user sees, through DNS and the host's edge | **Open:** not built yet |

*Rejected: one system evaluating everything.* Each consolidation copies data out of its home, and
each copy is one more thing that can break silently.

### Logs

Both processes write JSON lines to stdout ([`@gbd/core/log`](packages/core/src/log.ts)), and they
leave the host only through App Platform's log forwarding, set in each app's spec. Both apps
forward to one Better Stack source, so an incident that crosses them reads in time order. The
free plan keeps three days. A request is found by `requestId`, which the response returns as
`X-Request-Id`, and an attempt by `attemptId`.

*Rejected: shipping from inside the process* (`@logtail/pino`). A dying process takes its unshipped
lines with it, and those are the lines that matter.

### Metrics

Product metrics are views in the database's `metrics` schema, one row per event, read only by the
`metrics_reader` role, which can read nothing else. Dashboards and alerts query those views rather
than the base tables, so each metric has one tested definition. The reasoning is in
[`packages/db/migrations/009_metrics.ts`](packages/db/migrations/009_metrics.ts).

## Failure modes

A design contract, not a description of the code — each row is a failure we have committed to
handling.

| Failure | Response |
| --- | --- |
| Web server does not respond to the client | The client sets timeouts, and retries automatically only where the request cannot have started an analysis |
| Web server has trouble with Supabase Storage | Timeouts and capped retries on every request; `withBlobStoreErrorHandling` logs the failure with context and returns a 503. Uploads use `async`/`await` so they do not block the server |
| Web server has trouble with Supabase Auth | An unreachable Supabase Auth is a 503 rather than signing the user out; a session it refuses is signed out and its cookie cleared. `classifyAuthResult` (`apps/web/src/lib/server/auth/identify.ts`) |
| Web server has trouble with Supabase | Timeouts on transactions; `withDbErrorHandling` returns 503 for a statement that never completed and 500 for one Postgres refused |
| Worker has trouble with Supabase or Supabase Storage | An error is never treated as a verdict. Loops absorb the failure and retry by ticking; processing a claimed attempt fails it as `infrastructure`; terminal writes get a bounded retry and are then re-attempted each tick until the database recovers, with reaping as the backstop. Records written after the verdict, such as the attempt's telemetry, get the bounded retry and are then logged and dropped. A claim statement Postgres *refuses* makes the worker drain and exit nonzero. Reasoning in `apps/worker/src/failures.ts` |
| Web server or worker is overloaded | Host alerts on CPU, memory, and restarts (§ Alerts). There is no disk alert; a full disk surfaces as abandoned attempts, for reasons in `.do/worker.yaml` |
| Worker child process crashes | The parent detects the termination and marks the attempt failed |
| Worker child process hangs | The child stops updating its progress file, which triggers both parent-side and other-worker defenses — see [Progress, leases, and reaping](#progress-leases-and-reaping) |
| A third-party API rate limits us, e.g. OpenAI | The child retries with backoff, then fails as `upstream_api`; the parent marks the attempt failed. We stay conservative with concurrency to limit the risk. Reasoning in `OpenAiLlmClient` (`python/insights/gbd_foodservice_insights/categorization/llm.py`) |
| Workers cannot keep up with demand | Alert on attempts waiting too long to be claimed |
| Workers fail unexpectedly, e.g. a container dies | The reaper marks the orphaned row `failed('abandoned')`. Alert when failing attempts exceed a threshold, and when attempts are not cleaned up within the expected window |
| Email is slow or down | The notification sweep retries a bounded number of times with exponential backoff (§ Result notifications), then gives up; delivery is best effort either way. Auth's own OTP email is a separate system this doesn't cover — **Open:** can we alert on that too? |
| The blob store is down while uploading a completed attempt's results | The verdict parks rather than being discarded — the analysis work is already paid for. It resumes on later ticks for up to `uploadRetryBudgetMs`, then converts to `failed('infrastructure')` |
| Database exhausts connections | Clients and the database periodically terminate connections, plus timeouts, to limit zombie connections. Use connection pools and cap the number of connections |

Two alert queries name what "notifications are broken" means concretely, both against
`analysis_attempt`: **gave up** is terminal, not `canceled`, unsent, and
`notification_attempts >= 5`; **stuck** is the same query without the attempts clause, and with
`finished_at < now() - interval '1 hour'` in its place.

## Data model

The database is the coordination point between the web app and the worker: the queue, the
analysis attempt state machine, and the audit trail all live there. A `report` is one accepted
upload; it has exactly one `input_file` and one or more `analysis_attempt` rows, each of which
produces `result_file` rows.

The model is in [`packages/db/README.md`](packages/db/README.md), which also names which file
answers which question about the schema, including why it is shaped the way it is.
