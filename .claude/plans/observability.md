# Observability: logs, metrics, and alerts

> **Status:** a proposal for the infrastructure [`REQUIREMENTS.md`](../../REQUIREMENTS.md)
> § Observability and § Metrics ask for, and that [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
> § Failure modes already promises alerts from. A human makes the vendor calls; this file exists
> so they do not have to re-derive them. Once decided, `ARCHITECTURE.md` gains an § Observability
> recording the choices, § After the decision below is rewritten as the `## PR N` sections that
> `/plan-advance` folds in, and the PR that lands the last one deletes this file.
>
> Written assuming [`hosting-provider.md`](hosting-provider.md)'s recommendation of DigitalOcean
> App Platform holds; § 7 says what moves if it does not. Provider facts were read from each
> provider's current docs on 2026-09-27 and move; free-tier limits drift fastest. Code facts are
> from a survey of the tree the same day.

## What we ask of it

The specific metrics and alerts are the easy part and are deliberately not designed here — once
the pipes exist, each is a small follow-up. What this file decides is the pipes: where a log line
goes, where a metric is defined and drawn, and what evaluates an alert. The constraints, most of
them already settled elsewhere:

1. **Server-side metrics come from database queries** (`REQUIREMENTS.md` § Out of scope), and
   there are no client-side metrics. Nothing here adds an instrumentation library to the request
   path; § 3.4 says when one would earn its place.
2. **Time series, if it is cheap.** "Reports over time" beats "reports right now", but a snapshot
   is acceptable if history costs real infrastructure.
3. **The alerts the architecture has already promised**: CPU, memory and disk from the host;
   attempts waiting too long to be claimed; failures over a threshold; attempts not cleaned up;
   and the two notification queries § Failure modes spells out.
4. **Metric definitions that live in this repo**, readable and testable, so the data scientist —
   and an AI agent working for them — adds one with a PR rather than in a vendor's UI.
5. **Pay for ease, but as a nonprofit.** Time-limited logs are fine; nothing to patch or restart
   ourselves, for the reason that rejected a Droplet in `hosting-provider.md`.

## 1. What the system already records, and the split it implies

The decisive fact is that **the database is already an event log for everything the product
does.** Every `analysis_attempt` row carries `created_at`, `claimed_at`, `lease_renewed_at` and
`finished_at` under ordering constraints, plus `status`, `failure_reason`, `attempt_number` and
the four notification columns; `report`, `input_file`, `result_file`, `rejected_upload` and
`organization_invite` are timestamped; `audit_event` is append-only; `auth.users` has
`created_at` and `last_sign_in_at`. Every metric in `REQUIREMENTS.md` § Metrics except AI cost
is a query over rows that already exist, and every one has history for free, because the rows
never leave. Even a snapshot-shaped question — how deep was the queue at 3pm on Tuesday — is
answerable after the fact: pending at time *t* is `created_at <= t` and `claimed_at` null or
later. Nothing needs to be sampled, pushed or stored to get a time series.

What the database does *not* record, and should not, is the other two signals:

| Signal | Today | Home |
| --- | --- | --- |
| What the product did — reports, attempts, queue, failures, notifications, invites, users | Postgres, permanently | Queried in place, § 3 |
| How the code behaved — per-request timing and errors; what a worker was doing when an attempt hung; the Python child's warnings | `console.*`, unstructured; the child's stderr is dropped except an 8 KB tail on a crash | Structured logs, forwarded off the host, § 2 |
| What the machines were doing — CPU, memory, restarts, request rate, p95 latency | The host | The host's own metrics and alerts, § 4 |

Each signal has one natural home, and the design puts each in it rather than pushing all three
through one tool. What exists today:

- **No logger.** Every server-side log line is a `console.*` call, unstructured and tied to no
  request or worker. [`structured-logging.md`](structured-logging.md) § Context has the survey.
- **The child's output is nearly all discarded.** [`spawn.ts`](../../apps/worker/src/child/spawn.ts)
  ignores stdout and keeps the last 8 KB of stderr, which reaches `failure_detail` only when the
  child dies by signal or an unexpected exit code. The Python side logs at WARNING to stderr; the
  library's INFO row-count lines are suppressed before they leave the process.
- **Nothing observes an idle worker.** There is no worker table or heartbeat; the only trace is
  `lease_renewed_at` on attempts it holds. The web app's
  [`/health`](../../apps/web/src/routes/health/+server.ts) runs `SELECT 1` and a bucket check
  and answers 503 when either fails; the worker has no port.
- **No read-only database role**, although `REQUIREMENTS.md` § Security asks for one. One
  connection string serves the web app, the worker and every script.
- **No views, no `pg_cron`, no extensions**, and neither alert query from § Failure modes exists
  as code.

## 2. Logs

### 2.1 Inside the process

One JSON object per line on stdout, from pino. The design and its PRs are in
[`structured-logging.md`](structured-logging.md), which lands ahead of this plan because none of it
waits on a vendor. What this file relies on from it: the host reads stdout and the process never
configures a destination (`ARCHITECTURE.md` § Images); every web request writes one access line
carrying the `x-request-id` the response returns (§ 3.4); worker lines carry `workerId`,
`attemptId` and `reportId`; and every record fits § 2.2's 2000-byte line cap.

### 2.2 Where they go

DigitalOcean keeps build and deploy logs for 90 days and **runtime logs not at all** — the app
spec's `log_destinations` forwards them by rsyslog, with a hard 2000-byte cap per line — so the
destination is a day-one decision, as `hosting-provider.md` already noted.

| | Better Stack | Papertrail | Datadog | Axiom | Grafana Cloud Loki |
| --- | --- | --- | --- | --- | --- |
| DigitalOcean forwards to it | Yes | The spec still has a `papertrail` type; the docs' destination table dropped it. **Open** | Yes | No | No |
| Free tier | 3 GB/mo, **3 days** | 50 MB/mo, 48 h | None for logs | 500 GB/mo, 30 days | 50 GB/mo, 14 days |
| First paid step | Nano: 40 GB, 30 days, $30/mo ($25 yearly) | $7/mo: 1 GB, 7 days | Per GB ingested plus per million events indexed | $25/mo | Pro: $19 base plus per GB |
| Parses our JSON into fields | Yes, including JSON inside a syslog line | No | Yes | Yes | Yes |
| Also brings | 10 uptime monitors at 30 s, 10 heartbeats, a status page, Slack and email, SQL over logs | Search | Everything, at Datadog's complexity | Dashboards, alerts | One pane with § 3 |

Volume: at the planned 500 reports a month, a five-minute attempt polled every 10 s
(`BASE_POLL_INTERVAL_MS` in [`schedule.ts`](../../apps/web/src/lib/polling/schedule.ts)) is
about 30 access lines, plus perhaps 20 worker lines per attempt and the page loads around it —
tens of thousands of lines and tens of megabytes a month. **Volume will never be the cost;
retention is.** Every free tier above absorbs ours many times over; they differ on how many days
back a line can still be found.

**Recommendation: Better Stack, free tier first.** It is the only destination DigitalOcean
forwards to that also brings the uptime monitor § 4 wants, and the only one of those with a free
tier that fits. Three days is short, and the reason to accept it at launch is that the *durable*
record of a failure is `failure_reason` and `failure_detail` on the row, which the database keeps
forever; logs answer *how* it failed, which matters most in the hours after. The trigger to buy
Nano is the first time someone needs a line older than three days and does not have it — probably
the first support question.

*Rejected: Datadog.* Its Postgres integration is an Agent we cannot run on App Platform, so it
would be logs only, at a price and complexity built for larger teams.
*Rejected: Grafana Loki, even though § 3 puts everything else in Grafana.* DigitalOcean does not
forward to it, so lines would be shipped from inside the process (`pino-loki`), and a process that
dies takes its unshipped lines with it — exactly when they matter. Axiom, otherwise the most
generous free tier here, fails on the same point. Both return on Railway (§ 7), which forwards
nothing.
*Rejected: Papertrail.* It would have been the boring choice, but DigitalOcean's destination table
no longer lists it and it brings no monitors.

**Supabase's own logs** — Postgres, Auth, Storage — stay in the Supabase dashboard, seven days on
Pro. *Rejected: Log Drains* to bring them alongside ours: $60/month per drain plus $0.20 per
million events, for logs we rarely read.

## 3. Metrics

### 3.1 Time series, and why it is cheap

Yes, without sampling, from three sources:

1. **Product metrics are `GROUP BY` over event tables** (§ 1). Grafana's Postgres data source has
   the `$__timeGroup` macro for exactly this; attempts per day, p95 queue wait per hour, failures
   by reason per week are each one SQL statement, with history as long as the tables.
2. **Database health** — CPU, connections, disk, WAL — comes from Supabase's Prometheus endpoint
   (`/customer/v1/privileged/metrics`: ~200 series, basic auth with the secret key, scraped once a
   minute, beta), which Grafana Cloud's *Metrics Endpoint* integration scrapes from its own side
   with no agent anywhere. That covers the "database exhausts connections" failure mode with 14
   days of history on the free tier.
3. **Container health** — CPU, memory, restarts, request rate, p95 latency per service — is
   DigitalOcean's Insights tab. **Open:** how far back it keeps them is undocumented.

What cannot be reconstructed is exactly one thing: whether a worker was *alive* while idle.
*Considered, not done: a heartbeat row per tick.* Every failure mode § Failure modes lists is
caught without it — a dead fleet shows up as attempts waiting to be claimed the moment there is
demand, a crash loop as the host's restart-count alert — so a heartbeat only buys earlier notice
during a quiet hour. Add a `worker_heartbeat` table the metrics role can read when that notice is
missed.

### 3.2 Where definitions live: views in a `metrics` schema

**Each metric is a Postgres view in a `metrics` schema, created by a Kysely migration**, exposing
a tidy row per event with the derived columns already computed: `metrics.attempt` with
`queue_seconds`, `run_seconds`, `status`, `failure_reason` and `attempt_number`;
`metrics.report`; `metrics.rejected_upload`; `metrics.user_signup` from `auth.users`'
`created_at` and `last_sign_in_at`; `metrics.queue_backlog` (pending attempts and their age);
`metrics.notification_backlog` (the "gave up" and "stuck" rows, each with a `kind`). Views expose
facts; a dashboard buckets them by time and an alert rule counts them. The same view then serves
a daily chart, an hourly chart, an alert and a notebook, and "queue wait" has one definition that
can drift.

What that buys, in order:

- **It lives here and executes.** The definition is a migration — versioned, reviewed, applied by
  the same deploy step as any schema change ([`deploy-migrations.md`](deploy-migrations.md)), and
  dumped by `gen-types` into a `metrics-schema.sql` beside
  [`public-schema.sql`](../../packages/db/public-schema.sql), checked by the same CI job, so the
  current definitions are one file. Each view gets a vitest test in `packages/db` that seeds rows
  inside `withRollback` and asserts the view's output with `toEqual`, filtered to the seeded ids
  since a view also sees committed leftovers from the concurrency tests; `DB_NOW` and `dbMsAgo`
  in [`fixtures.ts`](../../packages/db/src/testing/fixtures.ts) already exist for the age-based
  views, and "every metrics view has a test" joins the conventions list in
  [`packages/db/README.md`](../../packages/db/README.md). Adding a metric is a migration, a test
  and a panel, and `pnpm check && pnpm test` says whether the first two are right. That is the
  loop an AI agent can run unattended, and it is the whole reason for choosing views over any
  other container.
- **One read-only role reads it.** `metrics_reader` — `LOGIN`, `default_transaction_read_only`,
  a `statement_timeout` and a `CONNECTION LIMIT` set on the role, `USAGE` on `metrics` and
  `SELECT` on its views and nothing else — so a bad dashboard query is a timeout in Grafana rather
  than load on production, and Grafana's default 100-connection pool cannot eat the pooler's
  budget. Views run with their owner's privileges, so `metrics_reader` reads `auth.users`'
  timestamps through `metrics.user_signup` without ever being granted anything on `auth` or
  `public`. Grafana connects as it through the Supavisor session pooler like everything else; so
  do the data scientist's notebooks — `python/lab` reads no database today, and this role is how
  it should start. It also answers `REQUIREMENTS.md` § Security's read-only-access line.
- **Kanel does not type it, on purpose.** [`kanel.config.cjs`](../../packages/db/kanel.config.cjs)
  keys every relation by bare name across its `schemas`, so a `metrics.report` view would collide
  with the `report` table in the generated `Database` type; the option that prefixes schema
  names renames every existing key in both apps. Nothing in TypeScript needs the views — the
  tests use `sql<Row>` as [`conventions.test.ts`](../../packages/db/tests/conventions.test.ts)
  already does — so Kanel stays on `public` and `auth`, and the schema dump is the typed record.

Roles are cluster-level, and the trap has two halves. On the hosted project the role outlives any
database reset; locally the test stack migrates the `postgres` database and a template database
concurrently under Turbo, so two migrations can race on the same `CREATE ROLE` and an
`IF NOT EXISTS` check loses. The migration therefore creates the role by catching
`duplicate_object`:

```sql
DO $$ BEGIN
  CREATE ROLE metrics_reader LOGIN NOINHERIT CONNECTION LIMIT 5;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

Its password is never in a migration — set once with `ALTER ROLE ... PASSWORD` in the Supabase
SQL editor; locally the role never logs in. **Open, verify before the migration lands:** that
hosted Supabase's `postgres` role, which is not superuser, has `CREATEROLE`; and that Supavisor
accepts the role as `metrics_reader.<project-ref>`.

*Rejected: SQL files in an `observability/` directory that dashboards paste in.* Untyped,
untested without a harness of their own, and copied into every panel and alert that uses them.
*Rejected: a `metric_sample` table filled by `pg_cron`.* It is how one gets time series when the
source is a snapshot; § 3.1 shows ours are not. It stays in reserve for a metric that turns out
not to be reconstructible.
*Rejected: pushing computed metrics to the log vendor.* It makes the worker responsible for the
dashboards' correctness and reintroduces sampling — though see the runner-up under
§ Recommendation, where that trade buys a vendor.

### 3.3 Where they are drawn

| | Grafana Cloud | Better Stack | Metabase Cloud | Evidence Cloud | Supabase Studio |
| --- | --- | --- | --- | --- | --- |
| Queries Postgres directly | Yes | No — ClickHouse over what it ingests | Yes | Yes, at build time | SQL editor only |
| Time series over SQL | `$__timeGroup` | From logs and pushed metrics | Yes | Yes, static per build | No |
| Alerts on a query | Yes; Slack, email | On logs and metrics | Yes | No | No |
| Definitions as code | Dashboards via Git Sync (GA April 2026, bidirectional, dashboards and folders); alert rules via the provisioning API or Terraform | No | Serialization is Pro | Natively: markdown and SQL in a repo | No |
| Price | Free: 3 users, 10k series, 14 days for *scraped* series — Postgres-derived series have no retention limit. Pro: $19 base | In § 2.2 | $100/mo | Free for 5 viewers, then $500/mo | Included |

**Recommendation: Grafana Cloud, free tier.** It is the only candidate that queries the views in
place, alerts on the same SQL, and keeps dashboards in this repo. Git Sync's bidirectionality is
what makes it fit a data scientist: explore in the UI, save, and it opens a PR. Three seats is the
team plus the data scientist.

*Rejected: Evidence.* The most AI-friendly authoring model of any of them — markdown and SQL in
the repo — but it is static, rebuilt on a schedule rather than live, and has no alerting, so it
would be a second metrics tool beside whatever alerts.
*Rejected: Metabase Cloud.* $100/month buys a nicer ad-hoc query UI than Grafana's; wrong price
for us.
*Rejected: self-hosting Grafana or Metabase.* A Droplet, by another name.

### 3.4 When Prometheus would earn its place

Not now. `REQUIREMENTS.md` § Observability's "request durations and error counts" are covered
without it: DigitalOcean charts and alerts on request rate and p95 duration per service, and the
access log (§ 2.1) gives status counts and per-route timing in Better Stack. The moment is when
someone wants a distribution the host does not give — per-route latency histograms, say — and
then the path is `prom-client` behind a basic-auth `/metrics` route on the web app, scraped by the
same Grafana Cloud Metrics Endpoint integration as Supabase, still with no agent. The worker has
no port and would need one; until then its internals are log lines and attempt rows.

## 4. Alerts

Three layers, each evaluated where its data already is:

| Layer | Evaluates | Rules | Delivers | Defined in |
| --- | --- | --- | --- | --- |
| Host | DigitalOcean | CPU, memory, restart count per component; p95 latency and request rate on web; deploy failed | Email, Slack | `.do/app.yaml` `alerts:` — rules only; destinations are set once through the API. Free |
| Data | Grafana Cloud | SQL over `metrics.*`: queue wait, failure rate, notifications gave up or stuck, `processing` past the ceiling; connection count from the Supabase scrape | Email, Slack; Grafana IRM (3 users free) if paging is ever wanted | Grafana, exported to the repo as the reviewable record |
| Liveness | Better Stack | The dependency-checking health route, every 30 s | Email, Slack, one phone call on free | Its UI; 10 monitors free |

A Grafana alert over Postgres must be a time-series query — a `time` column and a numeric value —
so each rule is `SELECT now() AS time, count(*) AS value FROM metrics.<view> WHERE ...`, which is
what makes the views the natural unit for alerts too. There will be perhaps six rules and they
will rarely change, so they are authored in Grafana and exported into `observability/grafana/`
by a script; Grafana is the source and the repo copy is the review trail. *Considered, not done:
repo-first rules pushed through the provisioning API.* Right if drift ever bites; it costs a
token secret and a workflow for six rules.

**The health route splits.** DigitalOcean's `health_check` is a liveness probe — consecutive
failures restart the container — and today's `/health` fails whenever Supabase or the bucket is
unreachable, which would turn every Supabase blip into a restart loop, a `RESTART_COUNT` alert
firing for the wrong reason, and a failed deploy if the blip lands on the first checks. So:
`/health` answers 200 if the process is up, for the host; the dependency check moves to a second
path for Better Stack, whose monitor is then the "users cannot use the app" alert, distinct from
"the container died". [`hooks.server.ts`](../../apps/web/src/hooks.server.ts) skips auth by exact
path, so the new path joins it; Playwright's readiness probe keeps pointing at `/health`.

**Disk.** § Failure modes promises alerts on disk, and DigitalOcean has no disk rule. The worker
deletes each run directory when the attempt settles, the ephemeral disk is 4 GiB, and a full disk
replaces the container (`hosting-provider.md` § 5). **Open:** drop "disk" from the contract
(recommended), or have the worker log free space for Better Stack to threshold.

**Open:** where alerts are delivered — a Slack channel, or two email addresses. Every layer
supports both; decide once. There is no on-call; an alert reaches a person, not a rotation.

*Rejected: `pg_cron` and `pg_net` firing a webhook from inside Postgres.* Zero new vendors and
the rule is SQL in a migration — tempting. But it has no state: no "still firing", no silence, no
history, and every fire is a fresh HTTP call from the production database. Grafana runs the same
SQL with all of that for free.
*Rejected: Sentry.* Grouping and regression detection over 5,000 errors a month, on one seat —
and one seat means a shared login, which `hosting-provider.md` already ruled out; Team is
$26/month. At our error rate, `handleError`'s line in Better Stack behind a saved query is the
same information. Revisit when errors are frequent enough that grouping beats reading.

**Open, and it stays open here:** § Failure modes asks whether we can alert on Supabase Auth's
OTP email. Auth logs are in the Supabase dashboard and in none of the layers above, short of a
$60/month drain; the answer is the email provider's delivery webhooks, decided in
[`email-provider.md`](email-provider.md).

## 5. What it would cost us

| | Launch | When retention bites | Notes |
| --- | ---: | ---: | --- |
| Better Stack | $0 | $25–30 | Nano: 40 GB, 30 days |
| Grafana Cloud | $0 | $0 | Pro ($19 base) only for a fourth user or more than 14 days of *scraped* series |
| DigitalOcean alerts, Insights, forwarding | $0 | $0 | |
| Supabase | already paid | — | Pro's seven-day logs; no drain |
| **Total** | **$0** | **~$30** | |

Against `hosting-provider.md`'s $55/month planned scenario: nothing at launch, and about half the
hosting bill once logs are worth keeping.

## 6. Durability

Nothing here locks in, and that is the property to protect. Logs are stdout, so a different
destination is one `log_destinations` entry. Metrics are Postgres views, so a different dashboard
tool is a new data-source connection. Alerts are SQL, so they move with the views. Of the two
vendors, Grafana Labs is the older with an open-source core — if the free tier shrank, the
dashboard JSON runs on any Grafana. Better Stack is young and VC-backed, so its free tier is the
thing most likely to change, and the exit is Papertrail or Nano.

## 7. If the host is not DigitalOcean

- **Render** keeps 14 days of logs itself and streams to Better Stack, Datadog or Papertrail, so
  Better Stack becomes optional. It has no native CPU or memory alerts; its OpenTelemetry metrics
  stream (Pro) into Grafana Cloud's 10k series moves the host layer of § 4 into Grafana.
- **Railway** keeps 30 days of logs and has Monitors built in on Pro, and forwards nothing. Better
  Stack would mean in-process shipping (`@logtail/pino`), which § 2.2 rejected; the honest answer
  is Railway's own logs and alerts, keeping Better Stack only for the uptime monitor. Axiom and
  Loki become the in-process options if 30 days is not enough.
- Either way, **§ 3 does not move.** The views, the role, Grafana and the data alerts are
  provider-independent. Only the log destination, the host alerts and the record bound in
  `@gbd/core/log` follow the host, and a looser line cap only raises the bound.

## Recommendation

Structured pino logs, forwarded by the host to **Better Stack** (free, then Nano). Metrics
defined as **views in a `metrics` schema**, read by a `metrics_reader` role, drawn and alerted on
in **Grafana Cloud** (free). Host alerts in the **DigitalOcean app spec**. Uptime from Better
Stack. Two vendors, both at $0 to start, and nothing of ours to operate.

What we accept: three days of logs until we pay; 14 days of database-health history; Grafana's UI
over a BI tool's; and a fourth place configuration lives — Grafana — beside the app spec, the
migrations and `.env`.

**The runner-up is one vendor, and the honest case for it is this.** The worker already runs
three database-backed tickers; a fourth, every minute, could `SELECT` from the same views and
log one gauge record each — `{ metric: 'queue_backlog', pending, oldest_age_s }` — for Better
Stack to threshold. Its absence is the "worker is dead" alert for free, and Grafana, the
`metrics_reader` role and its password, and the pooler budget for a second reader all drop out of
the alerting path; the views still live in the repo exactly as § 3.2 describes, with the worker as
their first consumer. What it costs is the thing § 3.1 was built around: product history becomes
sampled gauges that live as long as Better Stack keeps logs — three days free, thirty on Nano —
so "users over time" and "reports over time", the first two metrics in `REQUIREMENTS.md`
§ Metrics, would need a Grafana-shaped tool anyway. Choose it if the team values one vendor
above unlimited history and would rather look at trends in a notebook.

What would change this: DigitalOcean losing (§ 7); Grafana Cloud gating Git Sync or Postgres
alerting behind Pro — then dashboards as JSON pushed by a script, at $19/month, or the runner-up;
Better Stack's free tier shrinking — then Papertrail if DigitalOcean still forwards to it, else
Nano from day one.

## After the decision

Structured logging needs no vendor account and no hosting decision, so it is a plan of its own,
[`structured-logging.md`](structured-logging.md), landing ahead of the rest. What follows is
roughly one PR each, in this order. The first two need no vendor account or hosting decision
either, so they can land now. The third contends with `hosting-provider.md`'s step 2 for the same
file and follows it.

1. **The health split.** `/health` becomes liveness; the dependency check moves to its own path,
   added to the auth skip in `hooks.server.ts`.
2. **The `metrics` schema and role.** Migration `002_metrics`: the schema, the first views
   (`attempt`, `report`, `rejected_upload`, `user_signup`, `queue_backlog`,
   `notification_backlog`), `metrics_reader` with its grants, timeout, read-only default and
   connection limit; a `dump-metrics-schema.ts` beside the public one, wired into `gen-types`
   and the `ts-db-types` CI check; a test per view; the README convention. `.env.example` gains
   nothing — the role's password is set in Supabase.
3. **Host config.** In `.do/app.yaml`: `alerts:` per component (`CPU_UTILIZATION`,
   `MEM_UTILIZATION`, `RESTART_COUNT`; `REQUEST_DURATION_P95_MS` on web) and at app level
   (`DEPLOYMENT_FAILED`); `health_check.http_path` at the liveness route; `log_destinations:`
   for Better Stack. The token is a plain string in the spec with no `SECRET` type, and the
   committed spec is canonical because `PUT /v2/apps` replaces it wholesale — so commit a
   placeholder and substitute a GitHub secret in the deploy step before `doctl apps update`
   (**Open:** whether `app_action/deploy@v2` substitutes anything beyond `IMAGE_DIGEST_*`). Then
   the one out-of-band step: alert destinations via `doctl apps update-alert-destinations`.
4. **Grafana Cloud.** The stack; the Postgres data source as `metrics_reader` through the pooler
   with a small max-connections (Grafana's published egress ranges go on the allowlist only if
   Supabase network restrictions are ever turned on); the Supabase metrics scrape job; Git Sync
   to `observability/grafana/dashboards/` and the first dashboard; the alert rules and the export
   script; the contact point.
5. **Better Stack.** The source for DigitalOcean, the monitor on the dependency route, and the
   Slack or email integration. Verify the first forwarded line arrives parsed into fields.
6. **Docs.** `ARCHITECTURE.md` gains § Observability, recording the three homes and the pipes;
   each § Failure modes row that says "alert" says where that alert lives, and "disk" is resolved
   one way or the other; this file is deleted.

Then the follow-ups this makes cheap, each its own PR and none blocking: the AI-cost metric, which
needs the child to write token usage into `result.json` (the `**Open**`s in
[`analysis.py`](../../python/insights/gbd_foodservice_insights/analysis.py) and
`REQUIREMENTS.md` § Persistence); raising the child's log level to INFO for the library's
row-count lines, a contract change because the child's env is an allowlist; and a
`worker_heartbeat` if § 3.1's gap is ever felt.

## Verification

Steps 1 and 2 are verified by `pnpm lint && pnpm check && pnpm test`. The vendor steps are
verified end to end, once, against the hosted stack:

- A request to the web app produces one JSON line in Better Stack with its fields parsed and the
  same `x-request-id` the response carried; a forced 500 produces a second line with a stack that
  fits in 2000 bytes.
- A Grafana panel over `metrics.attempt` shows a real attempt with the right `queue_seconds`;
  the Supabase scrape shows connection counts.
- Each data alert fires from a row that satisfies it and clears when the row is fixed; the
  liveness probe survives the dependency route being made to fail; the Better Stack monitor does
  not.
