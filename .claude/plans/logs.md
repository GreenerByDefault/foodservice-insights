# Production logs

## Context

Both processes already log one JSON object per line on stdout, through
[`@gbd/core/log`](../../packages/core/src/log.ts), but nothing reads stdout in production yet.
This plan sends those lines to Better Stack, which the team chose (`ARCHITECTURE.md` § Stack). The
comparison behind that choice is in
[the decision plan, as of the commit that recorded it](https://github.com/GreenerByDefault/foodservice-insights/blob/d7be6c7f32cf74b1310f98a608cf0f83df25c255/.claude/plans/observability-vendors.md#22-where-they-go).
Alerts on log lines and the uptime monitor are [`alerts.md`](alerts.md).

Facts from the tree and the vendors' docs (2026-10-14) that shape the design:

- **What the lines carry:**
  - The web writes one access line per request, with method, route, status, duration and user
    id. Every line inside a request carries the `requestId` that the response returns as
    `X-Request-Id` ([`hooks.server.ts`](../../apps/web/src/hooks.server.ts)).
  - Worker lines carry `workerId`, and an attempt's lines also carry `attemptId` and `reportId`.
  - A child's stderr reaches the log as one record per exit.
  - Nothing names the app that wrote a line except those fields, and pino's `hostname`.
  - Every record fits `MAX_RECORD_BYTES`, the forwarding cap.
- **App Platform keeps no runtime logs** unless they are forwarded. Build and deploy logs stay in
  its dashboard.
- **App Platform forwards to Better Stack natively**, through a `log_destinations` entry of type
  `logtail` that holds a source token. The entry is set per component in the spec
  ([reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)). On
  Better Stack's side it is a source of platform *DigitalOcean*
  ([guide](https://betterstack.com/docs/logs/digital-ocean-apps)). The forwarding happens outside
  our process, so a crashing process's last lines still arrive.
- **The token is a secret like any other.** DigitalOcean gives `log_destinations` no `SECRET`
  type, but the token is still a `${BETTER_STACK_TOKEN}` placeholder, filled from the `production`
  Environment at deploy ([`.do/README.md`](../../.do/README.md)).
- **The free plan keeps 3 GB a month for 3 days. Nano keeps 40 GB for 30 days, at $30 a month**
  ([pricing](https://betterstack.com/pricing)). We write tens of megabytes a month, so retention,
  not volume, is the cost.
- **A failure's durable record is on its row**: `failure_reason` and `failure_detail` on
  `analysis_attempt`, kept as long as the row is. Logs add how it failed.
- **`REQUIREMENTS.md` § Observability asks for "request durations and error counts".** App
  Platform's Insights tab charts request rate and p95 duration per app. Only the access lines have
  them per route.
- **Supabase's own logs** (Postgres, Auth, Storage) are in the Supabase dashboard, seven days on
  Pro.

## Decisions

- **One Better Stack source for production, which both apps forward to.** Reading an incident
  crosses both apps — the upload's request, the worker's claim, the child's exit — so they belong
  in one stream, in time order, behind one token. **Open, verify in PR 1:** whether forwarded
  lines carry the app and component names. If they do not, each app's root logger gains a
  `service` binding, `web` or `worker`.
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
- **Local development is unchanged.**
- *Rejected: Supabase Log Drains*, to bring Supabase's logs alongside ours. A drain costs $60 a
  month plus per-event charges, for logs we rarely read.
- *Rejected: shipping from inside the process* (`@logtail/pino`). A dying process takes its
  unshipped lines with it, and those are the lines that matter. Also, stdout is the whole
  interface (`log.ts`).
- *Considered, not done: the edge's request id on the access line.* `hooks.server.ts` leaves room
  for it "once the host is chosen". But the id a user is shown is Cloudflare's Ray ID, on
  Cloudflare's own error pages, and those appear when our app did not answer. PR 1 trims that
  comment.

## PR 1 — forward to Better Stack

- By hand first:
  - the Better Stack team, with every team member invited;
  - one source of platform *DigitalOcean*;
  - its token, as `BETTER_STACK_TOKEN` in the `production` Environment.
- `.do/web.yaml` and `.do/worker.yaml`: a `log_destinations` entry on each component, holding the
  placeholder. The deploy step passes the token through, as it does every secret.
- If the **Open** in Decisions needs it, the `service` binding in both root loggers, with a test
  that a line carries it.
- `hooks.server.ts`: the comment on `requestId` drops "once the host is chosen".
- By hand, after the first lines arrive: the saved queries and the dashboard.
- `ARCHITECTURE.md` § Observability, which `alerts.md` created, gains § Logs. It says
  that logs leave the host only through App Platform's forwarding, into one Better Stack source
  kept for three days. A request is found by `requestId`, and an attempt by `attemptId`.
- Delete this plan.

## Verification

`pnpm lint && pnpm check && pnpm test`. Then, against production:

- A request to the web app arrives as one access line, with its fields parsed and the
  `requestId` the response carried.
- An attempt's worker lines, the child's exit included, are in the same stream, found by
  `attemptId`.
- A record at the size cap arrives whole and parsed, not split. Post an oversized report to
  `/csp-report`: its `warn` line arrives with `truncated` naming what was dropped.
