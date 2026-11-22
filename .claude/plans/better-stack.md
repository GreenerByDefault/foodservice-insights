# Better Stack

## Context

Both apps forward their stdout to one Better Stack source (#659, `docs/architecture.md` § Logs). What
is left is everything the team reads that stream through, and the two alerts
[`alerts.md`](alerts.md) gave to Better Stack: the uptime monitor and the `error`-line alert.

**The repo half is on the `finish-better-stack` branch**: the runbook
`docs/runbooks/trace-a-problem-through-the-logs.md`, its line in the runbooks README, and
`docs/architecture.md` § Logs and § Alerts written as if the checklist below is done. Merge it,
deleting this plan in the same PR, once the checklist is done and its **Open**s are settled.

Facts from two production lines (2026-10-18), a web access line and a worker's `Worker started`:

- **Each line names its app in `syslog.appname`**: `foodservice-insights-web` or
  `foodservice-insights-worker`. `message_json.hostname` names the pod.
- **The JSON is parsed** into `message_json`, and pino's `level` label is lifted to the top-level
  `level`. **`message` is empty**: the text is `message_json.msg`.
- **The access line carries what the presets need**: `requestId`, `routeId`, `path`, `status`,
  `durationMs`, `isDataRequest`, `userId`. `Worker started` carries `workerGitSha`. An attempt's
  lines carry `attemptId` and `reportId`.
- **Probes and polls are not in the stream.** Their access lines are `debug`
  ([`hooks.server.ts`](../../apps/web/src/hooks.server.ts) `UNATTENDED_ROUTES`).
- **`error` lines are already rare and deduplicated** ([`failureStreak`](../../apps/worker/src/failures.ts),
  `handleError`).

Facts from Better Stack's docs (2026-11-22):

- **Saved views are Live tail "Presets"** (top left of Live tail). It ships a few for HTTP
  requests, database queries and errors, keyed to its integrations' field names. Ours need our
  own.
- **No ready-made dashboard fits.** About 150 templates, nearly all tied to an integration
  (Kubernetes, Heroku, Vercel, the clouds). None reads a generic JSON source from App Platform.
- **Dashboards chart metrics, not lines.** Every source gets a `logs_count` metric with a `level`
  label for free. Charting a JSON field, such as `durationMs` by `routeId`, needs a
  **Logs to metrics** extraction on the source first
  ([docs](https://betterstack.com/docs/logs/dashboards/logs-to-metrics/)).
- **A log alert is an alert on a dashboard chart**: there is no separate Alerts page
  ([docs](https://betterstack.com/docs/logs/dashboards/alerts/)).
- **Seats:** a "Team member (Telemetry access)" is free. A "Responder (Incidents + Telemetry)" is
  paid per seat, and the uptime docs route incidents to responders and on-call.
- **The free plan:** logs kept 3 days, 3 GB a month. We write tens of megabytes. 10 monitors and
  heartbeats, checked every 3 minutes, alerting by email or Slack. The pricing page does not say
  which plan has dashboards, SQL, log alerts or escalation policies.

Still open, settled by the checklist:

- **Open:** whether the free plan allows each of presets, Logs to metrics, dashboards and a chart
  alert. Whatever it refuses waits for Nano.
- **Open:** whether presets are shared with the whole team, or only with whoever made them.
- **Open:** whether a free plan's incidents email every team member, or only responders and the
  account owner. If only the owner, the monitor emails a shared address the team reads.

## Decisions

### Free until a line is missed

Buy Nano the first time someone needs a line older than three days and it is gone, which will
probably be the first support question.

### Presets live in Better Stack; procedures live in the runbook

A preset is a filter made in a few clicks, kept where it is used; a copy in the repo would drift.
The procedure that crosses systems, from a user's report to the row and then to the lines, is the
runbook. Looking up one `requestId`, `attemptId`, `reportId` or `userId` is a search, not a
preset.

### A dashboard over the access lines, if Logs to metrics is free

Requests by status, and p95 `durationMs` by `routeId`: the per-route half of
`docs/requirements.md` § Observability's "request durations and error counts", which App
Platform's Insights tab charts only per app. If the free plan refuses Logs to metrics, the
dashboard holds only the error chart the alert needs, and the per-route charts wait for Nano.

### The monitor and the `error`-line alert, made in the UI

*Rejected: Better Stack's Terraform provider.* That is state to keep for a few settings made once.

- **One monitor on the public `/health/ready`**, through the same DNS and edge a user goes through.
  *Considered, not done: paying for 30-second checks.* Buy them if an outage is ever reported to
  us before the monitor fires.
- **An alert on any `error` or `fatal` line** from either app. If the free plan cannot alert on a
  chart, the Errors preset is read whenever another alert fires, until logs are paid for.
- *Considered, not done: a heartbeat from the worker.* A dead fleet shows up as queue wait once
  there is demand, and a crash loop as `RESTART_COUNT`.
- *Considered, not done: a scheduled check that submits a form.* It would write rows into the
  metrics the data rules count.
- *Rejected: an error tracker (Sentry, or Better Stack's own).* An SDK in both processes, for
  grouping we do not need while errors are few enough to read one by one.
- *Considered, not done: a status page.* The users are a few organizations we talk to directly.

## The Better Stack checklist

All by hand, in [Better Stack](https://telemetry.betterstack.com). Do them in order: step 1 checks
the field names every later step uses.

### 1. Check the field names

In Telemetry → Live tail, click a recent web `Request` line to expand it. Confirm that
`syslog.appname`, `level`, `message_json.msg`, `message_json.status`, `message_json.durationMs`
and `message_json.routeId` are there under those names. If a name differs, use the real one below.
Then search `message_json.status>=200`: if that finds nothing, Better Stack typed `status` as a
string, and the numeric presets need a regex instead.

### 2. Make Live tail show the message

Sources → our source → Configure → Advanced settings → the Live tail message format. Set it to
`{message_json.msg|message}` and save. Setting it on the source, rather than through the Message
column's `⋯` → Configure, makes it everyone's default.

### 3. Invite the team

Team → invite each person as a **Team member (Telemetry access)**, which is free. Not as a
Responder, which is a paid seat.

### 4. The presets

Skip the built-in presets. For each row, type the query into Live tail's search, check that it
returns what the row says, then Presets → New, with the row's name.

| Preset | Query | For |
| --- | --- | --- |
| Web | `syslog.appname="foodservice-insights-web"` | Everything one app did |
| Worker | `syslog.appname="foodservice-insights-worker"` | " |
| Errors | `level=~/^(error\|fatal)$/` | What the alert fires on, to read when it does |
| Warnings and up | `level=~/^(warn\|error\|fatal)$/` | Children that exited nonzero, failed verdicts, CSP reports |
| Server errors | `message_json.msg=Request message_json.status>=500` | Which routes are failing, and for whom |
| Slow requests | `message_json.msg=Request message_json.durationMs>5000` | The requests behind the host's latency alert. 5000 is `REQUEST_DURATION_P95_MS` in [`.do/web.yaml`](../../.do/web.yaml) |
| Attempts | `message_json.attemptId=*` | Every attempt's claim, child exit and verdict, in order |
| Starts and stops | `message_json.msg=~/^(Worker started\|Received a signal)/` | Deploys and restarts, and which commit the worker ran |

(The `\|` is only Markdown escaping: type a plain `|`.) Then ask a teammate whether they see the
presets, which settles that **Open**.

### 5. The error chart and its alert

Dashboards → Create dashboard → **Blank dashboard**, named "Foodservice Insights". Add a chart,
choose SQL, and use the free `logs_count` metric:

```sql
SELECT {{time}} AS time, sum(logs_count) AS value
FROM {{source}}
WHERE time BETWEEN {{start_time}} AND {{end_time}}
  AND label('level') IN ('error', 'fatal')
GROUP BY time
```

Name it "Error and fatal lines". On the chart's **Alerts** tab, add a **Threshold** alert, "value
above 0", as a single incident, named "Error or fatal log line". Under who to notify, pick email to
every team member if it is offered.

If `label('level')` reads `info` for every line, it is the syslog level rather than pino's. Then
filter on a Logs to metrics label made from `message_json.level` instead.

### 6. The per-route charts

Sources → our source → Configure → **Extract metrics**. Add a metric from
`message_json.durationMs` with the aggregations count and p95, and labels from
`message_json.routeId` and `message_json.status`. It probably counts only lines that arrive after
it is made, so give it a day before judging the charts. Then add two charts to the dashboard,
with the query builder: count by `status`, and p95 by `routeId`.

If the free plan refuses Extract metrics, skip this step and note it in the PR.

### 7. The monitor

Uptime → Monitors → Create monitor → "URL becomes unavailable", for
`https://plate.greenerbydefault.org/health/ready`, at the free plan's 3 minutes. Name it "Web app
ready". Under "How should we escalate incidents?", choose email.

### 8. Verify

- A request to the web app is found by the `requestId` its response carried (`X-Request-Id`).
- An attempt's lines, the child's exit included, are found by `attemptId`.
- An oversized report posted to `/csp-report` arrives as one parsed `warn` line, with `truncated`
  naming what was dropped.
- A temporary monitor on a path that answers 404 emails everyone. Write down who got it, which
  settles the incident-email **Open**. Then delete the monitor. If only the owner got it, point the
  monitor and the alert at a shared address the team reads.
- A temporary copy of the error alert with `'info'` in place of `'error', 'fatal'` emails the same
  people. Delete it after.

### 9. Land the branch

Fix anything the checklist proved wrong in `docs/architecture.md` § Alerts, such as an alert the
free plan refused, then delete this plan and open the PR.
