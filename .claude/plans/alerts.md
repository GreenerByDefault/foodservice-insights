# Alerts

## Context

[`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Failure modes promises alerts, and
[`REQUIREMENTS.md`](../../REQUIREMENTS.md) § Observability asks for them. The vendors are chosen
(§ Stack): DigitalOcean App Platform hosts, Grafana Cloud runs dashboards and data alerts, and Better
Stack runs logs and uptime monitoring. The comparison behind those choices is in
[the decision plan, as of the commit that recorded them](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/observability-vendors.md).
This plan connects each promised alert to the system that already holds its data, and decides
where alerts are delivered. Logs are [`logs.md`](logs.md).

Facts from the tree and the vendors' docs (2026-10-14) that shape the design:

- **The host layer is live.** CPU, memory and restart rules per component, p95 latency on the web,
  and failed deploys and domains per app are in [`.do/web.yaml`](../../.do/web.yaml) and
  [`.do/worker.yaml`](../../.do/worker.yaml), each threshold with a comment saying what firing
  would mean. DigitalOcean emails the whole team. `ARCHITECTURE.md` § Observability → § Alerts
  holds the three-layer table, with the Data and Outside rows marked **Open**, and the § Failure
  modes overload row already names the host alerts and drops disk.
- **What § Failure modes still promises:**
  - workers cannot keep up: attempts waiting too long to be claimed;
  - workers fail unexpectedly: failed attempts over a threshold, and attempts not cleaned up
    within the expected window;
  - email is broken: the two notification queries under the table, *gave up* and *stuck*;
  - the database runs out of connections: pools and timeouts only, with no alert;
  - **Open** in that table: alerting on Supabase Auth's OTP email. It is not this plan's.
    [`email-provider.md`](email-provider.md) § Not yet: bounce and complaint webhooks decides
    there is no alert at launch, and names what would trigger building one.
- **[`metrics-pipeline.md`](metrics-pipeline.md) builds the pipe that data alerts ride.** It
  adds views in a `metrics` schema, read only by `metrics_reader`; `apps/grafana`, which holds
  dashboards as files; a local Grafana behind `gcx dev serve`; a check in `pnpm test` that runs
  every panel's query; and a `deploy-web` step that pushes to Grafana Cloud after the migration.
  Only the schema, the role and the base views have landed, in
  `packages/db/migrations/009_metrics.ts`, with their tombstones in `011_metrics_tombstones.ts`. Its `metrics.attempt` carries `status`, `failure_reason`, the
  three timestamps, and the notification columns these rules read. gcx manages alert rules as
  well as dashboards
  ([overview](https://grafana.com/docs/grafana/latest/as-code/observability-as-code/grafana-cli/gcx/overview/)).
- **Grafana Cloud can scrape Supabase's metrics endpoint**, about 200 series of database CPU,
  memory, disk and connections, through a built-in Supabase integration. **But it authenticates
  only with a secret API key.** Supabase's docs say these keys "provide full access to your
  project's data, bypassing Row Level Security", and none can be scoped
  ([API keys](https://supabase.com/docs/guides/api/api-keys)). Nothing in production holds one
  today.
- **Better Stack's free plan** gives 10 monitors and heartbeats, **checked every 3 minutes**
  (30 seconds is paid), and alerts by email or Slack but not by phone or SMS
  ([check frequency](https://betterstack.com/docs/uptime/check-frequency/),
  [pricing](https://betterstack.com/pricing)).
- **`error` lines are already rare and deduplicated.** The worker logs only the first failure of a
  streak at `error` ([`failureStreak`](../../apps/worker/src/failures.ts)). `handleError` logs at
  `error` only what no route anticipated, and SvelteKit's own 404s and 405s are not logged.
  Levels are written as labels: `"level":"error"`.
- **Locally, mail goes to Mailpit**, inside the local Supabase stack.

## Decisions

### Each alert is evaluated where its data already is

`ARCHITECTURE.md` § Alerts states the principle and rejects one system evaluating everything. The
two layers left to build:

| Layer | Evaluated by | Rules | Defined in |
| --- | --- | --- | --- |
| Data | Grafana Cloud | `count(*)` over `metrics` views: queue wait, failures, attempts left `processing`, notifications gave up or stuck, database connections | Rule files in `apps/grafana/`, pushed by `deploy-web` |
| Outside | Better Stack | The public `/health/ready`; any `error` log line | Its UI |

The data alerts fire when the host is healthy but the queue is not. The monitor is the one alert
that sees what a user sees, so it fires when the host's edge, DNS or TLS is what broke.

### Docs land with each PR

Each PR fills in its layer's row of `ARCHITECTURE.md` § Alerts and rewrites the § Failure modes
rows its alerts make true, so the docs never promise an alert that does not exist, nor lag one that
does. Thresholds and what firing would mean live on the rules themselves, never in a doc.

### Delivery: email, to each person

Every layer emails the team. Every vendor supports email on its free plan, and email needs no
shared workspace. It is also the one channel the local Grafana can deliver to (Mailpit), so a
data rule runs its whole path, from SQL to inbox, before it ships. There is no on-call: an alert
reaches a person, not a rotation.

- Better Stack emails its own team members, set once, by hand.
- Grafana's contact point lists addresses. The repo is public, so they live in an `ALERT_EMAILS`
  variable in the `production` Environment, not in a file. Code pushes the contact point, the
  same way it pushes the data source.

*Considered, not done: Slack.* Every vendor supports it equally. Switching means one contact
point per vendor, if the team ends up working in a Slack channel.

### Data rules

- **Each rule is a `count(*)` over a `metrics` view, with a threshold.** The view holds the
  definition (`metrics-pipeline.md` § Definitions), and the rule holds the threshold, so tuning
  an alert is an edit to a rule file, never a migration. The rules, with where each starts:
  - **Queue wait:** a `pending` attempt created more than 30 minutes ago. At three concurrent
    slots (one worker, `maxConcurrentAttempts`) and 2–15-minute attempts, a wait that long means demand beyond capacity, or no worker
    claiming. It is also what fires when the only worker is wedged (`.do/worker.yaml` says why
    the worker has no probe).
  - **Failures:** any attempt failed for a reason that is ours. That is every reason except
    `unusable_data`, which is the user's file. At ~17 attempts a day, each such failure is worth a
    look. Raise the threshold when that gets noisy.
  - **Not cleaned up:** an attempt still `processing` past `claimedCeilingMs` plus one sweep. Every
    live worker's reaper would have converged it by then, so no reaper is running. The rule's
    comment names [`config.ts`](../../apps/worker/src/config.ts), whose value the rule must
    exceed.
  - **Notifications gave up** and **stuck:** ARCHITECTURE.md's two queries. *Stuck* also
    requires that the attempt still have a requester, as the due predicate in
    [`notifications.ts`](../../apps/worker/src/sweeps/notifications.ts) does. Otherwise an attempt
    whose requester was deleted would fire forever. `metrics.attempt` carries
    `notification_attempts`, `notification_email_sent_at`, and `has_requester` from its first
    version.
  - **Connections:** total connections above 80% of `max_connections`.
  - *Considered, not done: a child's peak memory.* `analysis_attempt_telemetry.peak_memory_kib`
    is the exact reading the worker's host memory rule averages away, but a child killed for
    memory already fails its attempt, which the failures rule counts. Add it if those failures
    show up, or when the worker drops to 1 GB.
- **`metrics.database_connection` is one row per role**, counted from `pg_stat_activity`, beside
  the role's `CONNECTION LIMIT` and the server's `max_connections`. Like every view, it runs with
  its owner's rights, so `metrics_reader` needs no new grant. It has a panel on the operations
  dashboard ([`dashboards.md`](dashboards.md)), so a person can see who holds the connections.
  [`budget.ts`](../../packages/db/src/budget.ts) remains where the limits are decided. The view
  only reports them.
- **A rule that errors fires.** Every rule's error state is *Alerting*. So a query broken by a
  migration, or a database Grafana cannot reach, alerts like a firing rule instead of going quiet.
  That makes the connections rule alert in the case it exists for: when the database is out of
  connections, `metrics_reader` cannot get one either. No-data is *OK*, because a count always
  returns a row.
- **Rule files sit beside the dashboards, in the resource format gcx pushes for alert rules.**
  **Open, verify in PR 2:** that gcx round-trips an alert rule through `gcx dev serve` the way it
  does a dashboard. If it does not, rules are files that `deploy.ts` pushes through Grafana's
  alerting provisioning API. Either way, edits made in the Cloud UI are overwritten at the next
  deploy.
- **The contact point and notification policy are code**, like the data source. They are built
  from `ALERT_EMAILS`, which points at Mailpit locally, and upserted by the same script. Each
  person gets one email when an alert fires and one when it resolves.
- **Every rule's query runs in `pnpm test`.** The panel check from `metrics-pipeline.md` PR 2
  also reads the rule files and sends each query through Grafana against its run database. A rule
  must return exactly one number, and zero passes. So a view change that breaks a rule fails
  `pnpm test` and names the rule. Whether each rule fires on the rows it should is checked once,
  by hand, on the local Grafana (§ Verification).

### Database health: a view, not Supabase's scrape

`metrics.database_connection` covers the one database failure mode § Failure modes names. It uses
the credential Grafana already holds, and `pnpm test` checks it like any other view.

*Considered, not done: Grafana Cloud's Supabase integration.* It scrapes the project's metrics
endpoint into a ready-made dashboard, but it needs a secret key, which is full access to every
table and every stored file. That would be the only production copy of such a key, held by a third
party, to draw charts the Supabase dashboard already draws. Revisit if someone needs an alert on
database CPU or disk, or history longer than Supabase's dashboard keeps. Then give it a dedicated
secret key, so it can be revoked on its own.

### Outside: Better Stack

- **One monitor on the public `/health/ready`**, through the same DNS and edge a user goes
  through, every 3 minutes on the free plan. It watches the starter domain until
  [`custom-domain.md`](custom-domain.md) moves users to our domain, and then moves with them. Three minutes is slow for a page, but the host's readiness probe and the data
  rules see most outages sooner. *Considered, not done: paying for 30-second checks.* Buy them if
  an outage is ever reported to us before the monitor fires.
- **An alert on any `error` line** from either app. `error` is already kept for things a person
  should read (§ Context), and this alert catches what no other layer does: a 500 on a page, a
  sweep that keeps failing, or a verdict write waiting out a database blip. Needs
  [`logs.md`](logs.md) PR 1. **Open, verify in PR 3:** whether the free plan alerts on a log
  query. If it does not, the query is saved and read whenever another alert fires, until logs
  are paid for.
- **Both are made in Better Stack's UI**, and `ARCHITECTURE.md` names them, so they are not
  invisible. *Rejected: Better Stack's Terraform provider.* That is state to keep for two settings
  made once.
- *Considered, not done: a heartbeat from the worker.* It would be free and would say "no worker
  is alive" during a quiet hour. Every failure mode is caught without it: a dead fleet shows up as
  queue wait once there is demand, and a crash loop as `RESTART_COUNT`. Add one if that
  quiet-hour notice is ever missed.
- *Considered, not done: a scheduled check that submits a form.* A wrong `PROTOCOL_HEADER` fails
  every mutating request while every GET passes. But [`custom-domain.md`](custom-domain.md)
  checks that by hand, and it changes only with configuration. A mutating request every few
  minutes in production would also write rows into the very metrics these rules count.
- *Rejected: an error tracker (Sentry, or Better Stack's own).* It means an SDK in both processes,
  and what it buys is grouping. That matters only once errors are too frequent to read one by one,
  and until then the `error`-line alert is the same signal.

## PR 1 — the connections view

`packages/db`, the next migration. Needs only the `metrics` schema and `metrics_reader`, which
have landed.

- `metrics.database_connection`, as in Decisions.
- A test in `tests/metrics.test.ts` that it counts the test's own connection, under its role.
  The existing conventions cover the rest: no free text, and `metrics_reader` can read it.

## PR 2 — the data rules

Needs `metrics-pipeline.md` PR 3, so that a push to Grafana Cloud exists, and PR 1 here.

- `apps/grafana/resources/`: one rule file per rule from Decisions, in a folder of its own.
  Thresholds sit in the files, each with a comment saying what firing would mean.
- `apps/grafana/src/`: the contact point and notification policy, built from `ALERT_EMAILS`, with
  a unit test of the builder. `scripts/start.ts` and `scripts/deploy.ts` upsert them.
- The local Grafana's compose file sends SMTP to Mailpit. `.env.example` and `.env.test` set
  `ALERT_EMAILS` to a placeholder address, since Mailpit accepts any.
- The panel check reads the rule files too (§ Data rules).
- A panel for `metrics.database_connection` on the operations dashboard, which this PR creates
  if `dashboards.md` PR 3 has not.
- `ALERT_EMAILS` joins the `production` Environment, and `deploy-web`'s Grafana step passes it.
- `ARCHITECTURE.md`:
  - § Alerts: the Data row names the rule folder in place of its **Open**.
  - § Failure modes: the queue-wait, failures, email and connections rows say the data layer
    raises them, and the connections row gains its alert.
  - The two notification queries under the table point at the rule files, which now hold them.

## PR 3 — Better Stack

After [`logs.md`](logs.md) PR 1, once production serves traffic.

- By hand: the `/health/ready` monitor and the `error`-line alert, both emailing every team member.
- `ARCHITECTURE.md` § Alerts: the Outside row names the monitor and the log alert, made in Better
  Stack's UI, in place of its **Open**.
- Delete this plan.

## Verification

Each PR runs its stack's gate: `pnpm lint && pnpm check && pnpm test`. Then by hand:

- Once the host rules deploy, `doctl apps list-alerts` shows them on both apps, and a threshold
  lowered below the current reading in the dashboard emails the team. The next deploy restores it.
  A push to `main` redeploys the web without firing its restart rule, since the new container's
  count starts at zero. If it does fire, the rule needs a threshold above one.
- After PR 2, on the local Grafana against the dev database:
  - A `pending` attempt backdated past the queue-wait threshold puts one email in Mailpit, and
    claiming it brings the resolve email.
  - The same holds for a failed attempt, and for a notification row stuck past an hour.
  - Stopping the database makes every rule fire as an error.
  - Renaming a column a rule reads fails `pnpm test`, naming the rule.
- After PR 2's first deploy, every rule shows as *Normal* in Grafana Cloud, and testing the
  contact point emails everyone.
- After PR 3, a temporary monitor on a path that answers 404 emails everyone. Delete it after.
