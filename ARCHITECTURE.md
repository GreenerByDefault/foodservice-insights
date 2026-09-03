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
| Edge / DDoS | Cloudflare |
| Hosting | **Open:** Railway vs Render vs DigitalOcean |
| Email | (**Open:** which provider), using HTTP and generated emails. |

## Components

| Component | Language | Owns |
| --- | --- | --- |
| `apps/web` | TypeScript | Frontend, backend routes, upload validation, file links |
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
plain `fetch()` rather than form actions — is in [`apps/web/README.md`](apps/web/README.md#routes).

## Auth

Auth is entirely within `apps/web` — Supabase Auth on the client, a `handle()` hook that resolves
the JWT into `locals` on the server. See [`apps/web/README.md`](apps/web/README.md#auth) for the
design.

## Client ↔ server

The client polls the server on the interval set by `BASE_POLL_INTERVAL_MS` in
[`apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/polling/schedule.ts`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/reports/%5BreportId=uuid%5D/polling/schedule.ts).

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
4. The child runs, writes its results into that folder, and exits.
  - Exit 0 plus a result file the parent can parse is success; exit 1 means the child wrote a failure instead; any other exit means it reached no verdict at all.
5. Upload the result files to the blob store and save metadata to the database.

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
| `ThreadPoolExecutor` inside `gbd_foodservice_insights` | Speeds up an *individual* attempt |
| More child processes per worker (vertical) | More concurrent attempts; limited by CPU and memory contention |
| More workers (horizontal) | More concurrent attempts |

Note that `asyncio` is *not* the right tool inside `gbd_foodservice_insights`; use
`ThreadPoolExecutor`.

Every lever multiplies API load: `max concurrent API calls = workers × child processes × threads`.
Watch upstream rate limits when tuning any of them.

We will probably start with 2 workers, handling 4–6 concurrent attempts depending on whether each
worker runs 2 or 3.

### Deployments

Naively, deploying the worker kills in-flight analysis attempts, because the hosting platform
kills the old container. Two mitigations:

1. **Decouple the web app deployment from the worker**, so the worker is not redeployed
   unnecessarily.
2. **Let the worker drain.** The parent distinguishes `SIGTERM` from `SIGKILL`. Even if we cannot
   drain every attempt, we can catch most of them.

A grace period is worth being generous with: an attempt takes 2–15 minutes but typically about 5,
so a drain that runs long usually saves real work our own deploy would otherwise destroy. An
attempt still draining when the grace runs out gets `failed('shut_down')` — the one verdict that
means "nothing was wrong with this attempt, we just ran out of time to finish it."

**The hosting platform's own shutdown grace has to exceed `drainGraceMs` plus `killGraceMs`**,
[`config.ts`](apps/worker/src/config.ts) covers why — and this is a real trap, not a hypothetical
one: Render's shutdown delay defaults to 30s (configurable up to 300s), but Railway's
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0**. An unconfigured Railway service SIGKILLs
the worker mid-drain, and the failure looks like a worker bug rather than a platform default. This
is the one relation `createWorkerConfig` cannot check, since it depends on a setting that lives on
the platform, not in this repo.

## Hosting

What we care about: manual horizontal and vertical scaling; reliability, including automatic
restarts and draining the existing container on deploy; price; logging; continuous deployment with
the web app and worker separated; and overall simplicity over time. We explicitly do not care
about autoscaling.

**Deploys run database migrations before updating the app.** A failed code deploy can be rolled
back, but a migration cannot — once it has run, fix forward rather than reverting it.

**Open:** Railway vs Render vs DigitalOcean.

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

**Open:** decide which email provider, such as SendGrid. Idempotency-key support should be part of
that evaluation — it would close the last duplicate-send window § Result notifications leaves open.

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

**The web server accepts only CSV**; the client converts XLSX to CSV before uploading, taking
care with Excel dates.

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

**Server config is read at runtime, not inlined at build time** — `$env/dynamic/private` rather
than `$env/static/private`. One build artifact therefore runs against any environment, and
rotating a credential does not require a rebuild. The cost is that no server module may read
config at the module-level while being imported.

**Open:** no rotation process exists yet for suspected leaks.

Extra care with production access is warranted because AI agents operate in this repo.

## Failure modes

A design contract, not a description of the code — each row is a failure we have committed to
handling.

| Failure | Response |
| --- | --- |
| Web server does not respond to the client | The client sets timeouts, and retries automatically only where the request cannot have started an analysis |
| Web server has trouble with Supabase Storage | Timeouts and capped retries on every request; `withBlobStoreErrorHandling` logs the failure with context and returns a 503. Uploads use `async`/`await` so they do not block the server |
| Web server has trouble with Supabase | Timeouts on transactions; `withDbErrorHandling` returns 503 for a statement that never completed and 500 for one Postgres refused |
| Worker has trouble with Supabase or Supabase Storage | An error is never treated as a verdict. Loops absorb the failure and retry by ticking; processing a claimed attempt fails it as `infrastructure`; terminal writes get a bounded retry and are then re-attempted each tick until the database recovers, with reaping as the backstop. A claim statement Postgres *refuses* makes the worker drain and exit nonzero. Reasoning in `apps/worker/src/failures.ts` |
| Web server or worker is overloaded | Alerts on CPU, memory, and disk from the hosting provider |
| Worker child process crashes | The parent detects the termination and marks the attempt failed |
| Worker child process hangs | The child stops updating its progress file, which triggers both parent-side and other-worker defenses — see [Progress, leases, and reaping](#progress-leases-and-reaping) |
| A third-party API rate limits us, e.g. Gemini | The child retries with backoff, then fails; the parent marks the attempt failed. We stay conservative with concurrency to limit the risk |
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

The model and the reasoning behind it are in
[`packages/db/README.md`](packages/db/README.md), which also names which generated artifact
answers which question about the schema.
