# Better Stack

## Context

Both apps forward their stdout to one Better Stack source (#659, `docs/architecture.md` § Logs). What
is left is everything the team reads that stream through, and the two alerts
[`alerts.md`](alerts.md) gave to Better Stack: the uptime monitor and the `error`-line alert.

Facts from two production lines (2026-10-18), a web access line and a worker's `Worker started`:

- **Each line names its app in `syslog.appname`**: `foodservice-insights-web` or
  `foodservice-insights-worker`. `message_json.hostname` names the pod. So the loggers need no
  `service` binding.
- **The JSON is parsed** into `message_json`, and pino's `level` label is lifted to the top-level
  `level`. **`message` is empty**: the text is `message_json.msg`, so Live tail shows blank lines
  until its view is set to show `msg`.
- **The access line carries what the saved views need**: `requestId`, `routeId`, `path`, `status`,
  `durationMs`, `isDataRequest`, `userId`. `Worker started` carries `workerGitSha`.
- **Probes and polls are not in the stream.** Their access lines are `debug`
  ([`hooks.server.ts`](../../apps/web/src/hooks.server.ts) `UNATTENDED_ROUTES`), below
  production's level, so the stream at `info` is what people did.
- **`error` lines are already rare and deduplicated.** The worker logs only the first failure of a
  streak at `error` ([`failureStreak`](../../apps/worker/src/failures.ts)). `handleError` logs at
  `error` only what no route anticipated, and SvelteKit's own 404s and 405s are not logged.
- **The free plan:** logs kept 3 days, 3 GB a month. We write tens of megabytes. 10 monitors and
  heartbeats, checked every 3 minutes, alerting by email or Slack
  ([pricing](https://betterstack.com/pricing),
  [check frequency](https://betterstack.com/docs/uptime/check-frequency/)). Nano keeps 30 days.
  The pricing page lists dashboards, SQL and anomaly alerts without saying which plan has them.
- **A failure's durable record is on its row**: `failure_reason` and `failure_detail` on
  `analysis_attempt`. Logs add how it failed, for three days.

Not yet seen in production, checked in PR 1:

- An attempt's lines, the child's exit included, found by `attemptId`.
- A record at the size cap arriving whole. Post an oversized report to `/csp-report`: its `warn`
  line arrives with `truncated` naming what was dropped.
- **Open:** which of saved views, a dashboard, and an alert on a log query the free plan
  includes. Try each in the UI; whatever it refuses waits for Nano.
- **Open:** whether the free plan's uptime alerts reach every team member, or only the account
  owner. The pricing page's free team seat is Telemetry only. If only the owner, the monitor
  emails a shared address the team reads.

## Decisions

### Free until a line is missed

Buy Nano the first time someone needs a line older than three days and it is gone, which will
probably be the first support question.

### Saved views live in Better Stack; procedures live in the runbook

A view is a filter made in a few clicks over three days of data, so it is kept where it is used,
and a copy in the repo would drift from it. What the UI cannot hold is a procedure that crosses
systems, such as going from a user's report to the row and then to the lines. That is one entry in
[`runbooks.md`](runbooks.md).

The views, each one condition on top of the whole stream:

| View | Lines | For |
| --- | --- | --- |
| Web | `syslog.appname` is the web | Everything one app did |
| Worker | `syslog.appname` is the worker | " |
| Errors | `level` is `error` or `fatal` | What the alert fires on, to read when it does |
| Warnings and up | `level` is `warn`, `error` or `fatal` | Children that exited nonzero, failed verdicts, CSP reports |
| Server errors | `msg` is `Request` and `status` ≥ 500 | Which routes are failing, and for whom |
| Slow requests | `msg` is `Request` and `durationMs` over the `REQUEST_DURATION_P95_MS` rule in [`.do/web.yaml`](../../.do/web.yaml) | The requests behind the host's latency alert |
| Attempts | `attemptId` exists | Every attempt's claim, child exit and verdict, in order |
| Starts and stops | `msg` is `Worker started` or `Shutting down`, or starts `Received a signal` | Deploys and restarts, and which commit the worker ran |

Looking up one `requestId`, `attemptId`, `reportId` or `userId` is a search, not a view. The
runbook entry names the field.

### A dashboard over the access lines

Requests by status, and p95 `durationMs` by `routeId`. That is the per-route half of
`docs/requirements.md` § Observability's "request durations and error counts", which App Platform's
Insights tab charts only per app. Made in the UI, if the free plan has dashboards.

### The monitor and the `error`-line alert

Both made in the UI and named in `docs/architecture.md` § Alerts, so they are not invisible.
*Rejected: Better Stack's Terraform provider.* That is state to keep for a few settings made once.

- **One monitor on the public `/health/ready`**, through the same DNS and edge a user goes
  through. It watches the starter domain until [`custom-domain.md`](custom-domain.md) moves users
  to our domain, and then moves with them. Three minutes is slow for a page, but the host's
  readiness probe and the data rules see most outages sooner. *Considered, not done: paying for
  30-second checks.* Buy them if an outage is ever reported to us before the monitor fires.
- **An alert on any `error` or `fatal` line** from either app. These are already kept for things a
  person should read, and the alert catches what no other layer does: a 500 on a page, a sweep
  that keeps failing, or a verdict write waiting out a database blip. If the free plan cannot
  alert on a log query, the Errors view is read whenever another alert fires, until logs are paid
  for.
- Both email every team member, per [`alerts.md`](alerts.md) § Delivery.
- *Considered, not done: a heartbeat from the worker.* It would be free and would say "no worker
  is alive" during a quiet hour. Every failure mode is caught without it: a dead fleet shows up as
  queue wait once there is demand, and a crash loop as `RESTART_COUNT`. Add one if that
  quiet-hour notice is ever missed.
- *Considered, not done: a scheduled check that submits a form.* A wrong `PROTOCOL_HEADER` fails
  every mutating request while every GET passes. But `custom-domain.md` checks that by hand, and
  it changes only with configuration. A mutating request every few minutes in production would
  also write rows into the very metrics the data rules count.
- *Rejected: an error tracker (Sentry, or Better Stack's own).* It means an SDK in both processes,
  and what it buys is grouping. That matters only once errors are too frequent to read one by one,
  and until then the `error`-line alert is the same signal.
- *Considered, not done: a status page.* The free plan has one, but the users are a few
  organizations we talk to directly.

## PR 1 — read the stream, and alert on it

Production serves traffic, so nothing waits. Everything but the docs is by hand.

- The checks under § Context's "Not yet seen", settling both **Open**s.
- Live tail's view shows `message_json.msg` as the line.
- Every team member invited, as Telemetry members.
- The saved views, the dashboard, the monitor and the alert, as far as the free plan allows.
- [`runbooks.md`](runbooks.md): an entry, *Trace a problem through the logs*. From a user's report,
  the `X-Request-Id` or the time and their `userId`. From a failed attempt, `failure_reason` on its
  row, then its `attemptId`. Lines older than three days are gone.
- `docs/architecture.md`:
  - § Logs: a line's app is `syslog.appname`.
  - § Alerts: the Outside row names the monitor and the log alert, made in Better Stack's UI, in
    place of its **Open**.
- Delete this plan.

## Verification

- A request to the web app is found by the `requestId` its response carried.
- An attempt's lines, the child's exit included, are found by `attemptId`.
- An oversized `/csp-report` arrives as one parsed `warn` line, with `truncated`.
- A temporary monitor on a path that answers 404 emails everyone. Delete it after.
- If the log alert exists: a temporary alert on `level` `info` emails everyone. Delete it after.
