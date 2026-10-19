# Production logs

## Context

Both apps forward their stdout to one Better Stack source, through the `better-stack` entry in
each spec in [`.do/`](../../.do/README.md) (`ARCHITECTURE.md` § Logs). What is left is confirming
that the stream is readable in practice, and building the few things the team reads it through.
Alerts on log lines and the uptime monitor are [`alerts.md`](alerts.md).

Facts from the tree and the vendors' docs (2026-10-14) that shape the design:

- **What the lines carry:**
  - The web writes one access line per request, with method, route, status, duration and user
    id. Every line inside a request carries the `requestId` that the response returns as
    `X-Request-Id` ([`hooks.server.ts`](../../apps/web/src/hooks.server.ts)).
  - Worker lines carry `workerId`, and an attempt's lines also carry `attemptId` and `reportId`.
  - A child's stderr reaches the log as one record per exit.
  - Nothing names the app that wrote a line except those fields, and pino's `hostname`.
- **The free plan keeps 3 GB a month for 3 days. Nano keeps 40 GB for 30 days, at $30 a month**
  ([pricing](https://betterstack.com/pricing)). We write tens of megabytes a month, so retention,
  not volume, is the cost.
- **A failure's durable record is on its row**: `failure_reason` and `failure_detail` on
  `analysis_attempt`, kept as long as the row is. Logs add how it failed.
- **`REQUIREMENTS.md` § Observability asks for "request durations and error counts".** App
  Platform's Insights tab charts request rate and p95 duration per app. Only the access lines have
  them per route.

## Decisions

- **One stream, told apart by app only if it has to be.** **Open, verify in PR 1:** whether
  forwarded lines carry the app and component names. If they do not, each app's root logger gains
  a `service` binding, `web` or `worker`.
- **Free at launch.** Buy Nano the first time someone needs a line older than three days and it is
  gone, which will probably be the first support question.
- **Reading them: saved queries, and a dashboard over the access lines.**
  - Saved queries find one request by `requestId`, one attempt by `attemptId`, and every `error`
    line.
  - The dashboard shows requests by status, and p95 `durationMs` by `routeId`. That is the
    per-route half of § Observability's ask.
  - Both are made in Better Stack's UI. They read three days of lines and hold nothing a person
    could not rebuild in minutes.
  - **Open, verify in PR 1:** which of these the free plan includes. Whatever it lacks waits for
    Nano.

## PR 1 — read the stream

- By hand, once both apps have deployed with forwarding: run the production checks in
  Verification, and settle both **Open**s in Decisions.
- If lines do not name their app, the `service` binding in both root loggers,
  [`apps/web/src/lib/server/root-log.ts`](../../apps/web/src/lib/server/root-log.ts) and
  [`apps/worker/src/log.ts`](../../apps/worker/src/log.ts), with a test that a line carries it.
- By hand: the saved queries and the dashboard, as far as the free plan allows.
- Delete this plan. If nothing in code changed, that deletion is the whole PR.

## Verification

If the `service` binding landed, `pnpm lint && pnpm check && pnpm test`. Then, against
production:

- A request to the web app arrives as one access line, with its fields parsed and the
  `requestId` the response carried.
- An attempt's worker lines, the child's exit included, are in the same stream, found by
  `attemptId`.
- A record at the size cap arrives whole and parsed, not split. Post an oversized report to
  `/csp-report`: its `warn` line arrives with `truncated` naming what was dropped.
