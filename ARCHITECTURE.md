# Architecture

How the system fits together, and why. For *what* the product must do, see
[`REQUIREMENTS.md`](REQUIREMENTS.md). For how to run and build it, see
[`README.md`](README.md).

**tl;dr:** A SvelteKit web app (frontend and backend together) accepts a CSV upload, writes it to
a blob store, and enqueues an analysis attempt in Postgres. A long-running worker claims attempts
off that queue and spawns Python child processes that run the `catering_analysis` AI library. The
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
| Worker child process | Python, running `catering_analysis` |
| Queue | Postgres |
| Unit and component tests | vitest |
| End-to-end tests | Playwright |
| Edge / DDoS | Cloudflare |
| Hosting | **Open:** Railway vs Render vs DigitalOcean |
| Email | **Open:** GBD has no existing provider. Connect For Animals uses SendGrid. |

## Components

| Component | Language | Owns |
| --- | --- | --- |
| `apps/web` | TypeScript | Frontend, backend routes, upload validation, file links |
| Worker parent | TypeScript | Queue claiming, child process lifecycle, DB and blob store writes, email |
| Worker child | Python | One analysis run, via `catering_analysis` |
| `catering_analysis` | Python | The AI analysis library |
| `packages/*` | TypeScript | Shared database, storage, and domain code |

Only the web app and the worker parent touch the database and blob store. The child process
touches neither; it reads and writes a run directory the parent sets up for it.

## Supabase: database, auth, and blob store

Supabase provides the Postgres database, the blob store (Supabase Storage), and auth (Supabase
Auth). It is a good fit because Supabase Auth is free where standalone auth providers are
expensive, Supabase Storage has everything we need including an S3 API and presigned URLs, the
web UI and local development tooling are good, and the price is reasonable.

**We do not use client-side database access or Row Level Security (RLS).** All database access
goes through the server, the traditional architecture. RLS is easy to get wrong, substantially
increases the app's complexity and security risk, and increases vendor lock-in. The one exception
is Supabase Auth, which the client talks to directly.

**We use Supabase Storage through its S3 API**, not the Supabase JavaScript SDK, to reduce vendor
lock-in. We can switch blob store providers if cost becomes an issue.

## Web app

SvelteKit covers both the frontend and the backend. It is a fully fledged component framework,
which fits how much client-side state and interaction this app has, and it is close to writing
plain TypeScript, CSS, and HTML.

- *Rejected: Django.* Its ORM makes it easy to write unperformant queries, and templates are a
  poor fit for this much client interaction.
- *Rejected: React.* No advantage here, and heavier at runtime.

**Database access uses [Kysely](https://kysely.dev)**, a type-safe SQL builder: we write SQL
directly in TypeScript. This gives predictable query performance, unlike an ORM, while keeping
the ergonomics an ORM provides through TypeScript integration.
[Kanel](https://kristiandupont.github.io/kanel/) generates the types from the live database.
Kysely also handles migrations.

**Styling is Tailwind plus [shadcn-svelte](https://www.shadcn-svelte.com)**, whose components we
vendor in full, so we own them outright.

## Auth

The frontend uses Supabase Auth to log in, sign up, and log out. Supabase updates its own
database tables and issues a JWT, stored in a cookie. Every subsequent request carries that
cookie; a hook in the server validates the JWT and then does a database lookup for the user's
authorization — which organizations they belong to, and their role in each.

**We do not embed custom claims in the JWT.** The server looks up claims from the database on each
request instead, which is simpler and avoids stale-claim problems.

**Superadmin status lives solely on `app_user.is_superadmin`**, not as an `organization_member`
row. All superadmin behavior is a separate computed path (`is_superadmin OR role = 'admin'`)
rather than a variant of membership-table logic.

## Client ↔ server

The client polls the server roughly every 10 seconds.

- *Rejected: WebSockets or Server-Sent Events.* Both are dramatically more complex, and both
  require holding a connection open for the entire processing lifecycle. Keeping connections
  minimal and stateless simplifies performance and leaves the door open to horizontally scaling
  the web server.

## Server ↔ worker

The server enqueues new analysis attempts. **Workers pull from the queue; the server never talks
to a worker.**

The worker writes results — including failures — directly to the database and blob store. It does
not talk back to the server. The server discovers that a worker has finished by reading the
database.

## Worker queue

The queue is Postgres. A worker claims an attempt with a single statement:

```sql
UPDATE analysis_attempt
SET status = 'processing', worker_id = $1, locked_at = now(), last_heartbeat_at = now()
WHERE id = (
  SELECT id FROM analysis_attempt
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

This gives the semantics we need: roughly FIFO, concurrency-safe, and atomic. An index supports
the lookup — see [`packages/db/SCHEMA.md`](packages/db/SCHEMA.md).

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

`catering_analysis` is heavily IO-bound with many API calls: light CPU, moderate memory, no GPU.

The worker is a long-running process in a Docker container. It uses no web framework — it does not
serve requests.

The worker has a **parent process** that spawns up to 3 **child processes** running
`catering_analysis`. Each child is a separate Python process for isolation (spawn, don't fork).
**Only the parent interacts with the database and blob store**, which simplifies the child and
shrinks the security blast radius.

Parent lifecycle:

1. Pull an analysis attempt from the queue, if current attempts < 3.
2. Fetch the input file from the blob store.
3. Spawn a child process to run `catering_analysis`, setting up a folder with the required inputs.
4. The child runs. On completion it saves results to its folder and terminates, which signals
   success.
5. Upload the result files to the blob store, save metadata to the database, and email the result.

Whenever a child fails in any way — including being killed by its parent — the parent marks the
analysis attempt failed and sends an email.

### Language choice

The child must be Python to run `catering_analysis`. The parent could be anything; we use
TypeScript on Node.js so it can reuse the web app's database and blob store code. Node's async
model also suits an IO-bound, concurrent parent. The consequence: the Docker image must run both
our Node.js worker and the Python executable for the child.

### Heartbeats, hangs, and reaping

Three layered defenses, because a hung analysis has to be caught even if the process that should
notice it is itself hung:

1. **The child heartbeats** by updating a file every time it makes progress, such as finishing an
   API call. The parent checks that file roughly every 30 seconds and writes it to the database.
   If the child has not progressed in n minutes, the parent kills it as hung. The threshold must
   exceed the longest valid API call including backoff.
2. **The parent hard-kills** a child after a fixed ceiling no matter what, as a safety net for
   hung attempts. **Open:** 20 minutes?
3. **Other workers reap.** A parent can crash and leave its children orphaned, so every worker
   proactively looks for `processing` attempts with no heartbeat in the last k minutes, marks them
   failed, and sends an email. **Open:** 10 minutes?

Defense 3 introduces a race: another parent can kill an attempt while the original parent, being
hung, does not realize it. **All database updates to an analysis attempt must be written to
tolerate this** — see the terminal-state and status invariants in
[`packages/db/SCHEMA.md`](packages/db/SCHEMA.md).

### Canceling

When a user cancels, the web server marks the analysis attempt canceled in the database. The
parent detects that and kills the child process. No email is sent.

### Concurrency and scaling

Three independent levers:

| Lever | Effect |
| --- | --- |
| `ThreadPoolExecutor` inside `catering_analysis` | Speeds up an *individual* attempt |
| More child processes per worker (vertical) | More concurrent attempts; limited by CPU and memory contention |
| More workers (horizontal) | More concurrent attempts |

Note that `asyncio` is *not* the right tool inside `catering_analysis`; use
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

## Hosting

What we care about: manual horizontal and vertical scaling; reliability, including automatic
restarts and draining the existing container on deploy; price; logging; continuous deployment with
the web app and worker separated; and overall simplicity over time. We explicitly do not care
about autoscaling.

**Open:** Railway vs Render vs DigitalOcean.

## Blob store

The bucket is private. Layout:

```
org/{org_id}
    /rejected-upload/{rejected_upload_id}.csv
    /report/{report_id}
        /input/{input_file_id}.csv
        /analysis_attempt/{analysis_attempt_id}
            /result/{result_file_id}.{ext}
```

Keying everything under `org/{org_id}` means deleting an organization's files is a single prefix
delete.

> Moves to `packages/storage/README.md` when that package lands.

## File links

Per the requirements, file links are public and non-expiring: anyone with the link can access the
file. But a deleted report's links must stop working, while the file itself stays in the blob
store for debugging. Supabase Storage buckets are public or private as a whole, so a direct link
into a public bucket cannot express this.

Instead, **file links go through a lightweight public API on the web server.** The server checks
whether the file is still accessible, and if so issues a temporary signed URL from the blob store.
The bucket stays private; our stable links are the only way in.

Routing downloads through our server also means we can add server-side download metrics later.

## Input file upload and validation

**The web server accepts only CSV.** XLSX carries much more risk — zip bombs, macros — so the
client converts XLSX to CSV before uploading. The conversion must be careful with Excel dates.

**The file is sent directly to the web server**, not through a presigned upload URL. At a 10MB cap
the performance is fine, the server has to download the file for validation anyway, and it avoids
the risk of a presigned URL accepting arbitrary bytes.

**The web server fully validates before uploading to the blob store**, including security scans.
The client will likely do a quick structural check for better UX, such as confirming the header
has 3 columns. Because the server has already validated fully, the worker does not need to
re-validate exhaustively.

`catering_analysis` is already written to reduce prompt injection risk — for example, all output
belongs to a fixed set of values.

## Monorepo

The web app and the worker parent must share a repository: both are TypeScript and both use the
same database and blob store code.

`catering_analysis` also moves into this repository, which means open-sourcing it. The motivation
is the worker child process: a monorepo keeps the library in sync with the worker's API and makes
it simpler to ship in the worker's Docker image.

## Secrets management

Secrets load as environment variables. In production they are set on the hosting platform.
Locally, `.env` holds public values such as `localhost` addresses, and `.env.local` holds real
secrets such as API keys.

We use GitHub's secret scanning and push protection.

There is no rotation schedule, but the rotation process is documented in case we suspect a leak.

We are careful with production access — for example, documenting how to set up a read-only
Postgres role for debugging the production database. Extra care is warranted because AI agents
operate in this repo.

## Product categorization cache

`catering_analysis` currently ships a 40k-row CSV of historical product categorizations, used
purely as a cache. **This cache is the one part of the project that cannot be open-sourced.**

When the worker encounters new products it should add them to the cache, but new entries must go
through human review first. That workflow means the cache belongs in Postgres rather than a CSV,
regardless of open-sourcing: Postgres lets multiple workers update it safely and concurrently.

The flow: the child returns new categorizations to the parent; the parent writes them to the
database marked as needing human review; when starting a new child, the parent pulls the latest
copy of the cache down for it.

Consequence: we no longer store this CSV in Git.

## Failure modes

A design contract, not a description of the code — each row is a failure we have committed to
handling.

| Failure | Response |
| --- | --- |
| Web server does not respond to the client | The client sets timeouts, and retries automatically where appropriate |
| Web server or worker has trouble with Supabase Storage | Timeouts on transactions; a timed-out upload fails the request with a 500. Uploads use `async`/`await` so they do not block the server |
| Web server or worker has trouble with Supabase | Timeouts on transactions; return a 500 |
| Web server or worker is overloaded | Alerts on CPU, memory, and disk from the hosting provider |
| Worker child process crashes | The parent detects the termination and marks the attempt failed |
| Worker child process hangs | The child stops updating its heartbeat file, which triggers both parent-side and other-worker defenses — see [Heartbeats, hangs, and reaping](#heartbeats-hangs-and-reaping) |
| A third-party API rate limits us, e.g. Gemini | The child retries with backoff, then fails; the parent marks the attempt failed. We stay conservative with concurrency to limit the risk |
| Workers cannot keep up with demand | Alert on attempts waiting too long to be claimed |
| Workers fail unexpectedly, e.g. a code regression | Alert when failing attempts exceed a threshold, and when attempts are not cleaned up within the expected window |
| Email is slow or down | Auth stops working — **Open:** can we alert on this? The worker times out its email request; email is best effort |
| Database exhausts connections | Clients and the database periodically terminate connections, plus timeouts, to limit zombie connections. Use connection pools and cap the number of connections |

## Data model

The database is the coordination point between the web app and the worker: the queue, the
analysis attempt state machine, and the audit trail all live there. A `report` is one accepted
upload; it has exactly one `input_file` and one or more `analysis_attempt` rows, each of which
produces `result_file` rows.

The schema, its invariants, and the reasoning behind them are in
[`packages/db/SCHEMA.md`](packages/db/SCHEMA.md).
